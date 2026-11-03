import { readFileSync } from 'node:fs';
import type { gmail_v1 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import {
  type OriginalMessage,
  ReplyError,
  buildReply,
  encodeAddress,
  encodeHeaderText,
  originalFromMessage,
  replyRecipients,
  replyReferences,
  replySubject,
  splitAddresses,
} from '../src/gmail/draft.js';

const fixtureMessage = JSON.parse(
  readFileSync(new URL('./fixtures/reply-original.json', import.meta.url), 'utf8'),
) as gmail_v1.Schema$Message;

function original(overrides: Partial<OriginalMessage> = {}): OriginalMessage {
  return {
    threadId: 't-1',
    from: 'Alice <alice@example.com>',
    replyTo: '',
    to: 'me@example.com',
    subject: 'Hello',
    messageId: '<orig@example.com>',
    references: '',
    ...overrides,
  };
}

/** Decodes a draft's raw value back into unfolded headers and the decoded body. */
function decode(raw: string): { headers: Map<string, string>; headerBlock: string; body: string } {
  const message = Buffer.from(raw, 'base64url').toString('utf8');
  const split = message.indexOf('\r\n\r\n');
  const headerBlock = message.slice(0, split);
  const headers = new Map<string, string>();
  for (const line of headerBlock.replace(/\r\n /g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  const body = Buffer.from(message.slice(split + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { headers, headerBlock, body };
}

/**
 * Decodes RFC 2047 B-encoded words, for checking non-ASCII headers. As the RFC
 * says, whitespace is dropped only between two adjacent encoded words.
 */
function decodeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=(?:\s+(?==\?UTF-8\?B\?))?/g, (_m, b64: string) =>
    Buffer.from(b64, 'base64').toString('utf8'),
  );
}

describe('buildReply from a Gmail fixture', () => {
  const reply = buildReply(originalFromMessage(fixtureMessage), 'Thanks, paid today.', 'me@example.com');
  const { headers, body } = decode(reply.raw);

  it('keeps the draft in the original thread', () => {
    expect(reply.threadId).toBe('18c2e9f8a7b6c5d4');
  });

  it('sets threading headers from the original Message-ID', () => {
    expect(headers.get('in-reply-to')).toBe('<CAF9999@mail.example.com>');
    expect(headers.get('references')).toBe(
      '<CAF1111@mail.example.com> <CAF2222@mail.example.com> <CAF9999@mail.example.com>',
    );
  });

  it('replies to Reply-To and prefixes the subject', () => {
    expect(headers.get('to')).toBe('Billing Team <billing@example.com>');
    expect(headers.get('subject')).toBe('Re: Invoice #4711 follow-up');
    expect(reply.to).toBe('Billing Team <billing@example.com>');
  });

  it('writes a plain-text UTF-8 MIME body and leaves From/Date to Gmail', () => {
    expect(headers.get('mime-version')).toBe('1.0');
    expect(headers.get('content-type')).toBe('text/plain; charset="UTF-8"');
    expect(headers.get('content-transfer-encoding')).toBe('base64');
    expect(body).toBe('Thanks, paid today.');
    expect([...headers.keys()].sort()).toEqual(
      ['content-transfer-encoding', 'content-type', 'in-reply-to', 'mime-version', 'references', 'subject', 'to'].sort(),
    );
  });

  it('outputs base64url: no +, / or = characters', () => {
    expect(reply.raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('replySubject', () => {
  it.each([
    ['Hello', 'Re: Hello'],
    ['Re: Hello', 'Re: Hello'],
    ['RE: Hello', 'RE: Hello'],
    ['re:Hello', 're:Hello'],
    ['Re : Hello', 'Re : Hello'],
    ['Fwd: Hello', 'Re: Fwd: Hello'],
    ['Regarding the plan', 'Re: Regarding the plan'],
    ['  Hello  ', 'Re: Hello'],
    ['', 'Re:'],
  ])('%j -> %j', (input, expected) => {
    expect(replySubject(input)).toBe(expected);
  });
});

describe('replyRecipients', () => {
  it('uses From when there is no Reply-To', () => {
    expect(replyRecipients(original())).toEqual(['Alice <alice@example.com>']);
  });

  it('prefers Reply-To, including several addresses', () => {
    expect(replyRecipients(original({ replyTo: 'a@x.com, "Doe, Jane" <jane@x.com>' }))).toEqual([
      'a@x.com',
      '"Doe, Jane" <jane@x.com>',
    ]);
  });

  it("replies to the original recipients when the original was the user's own message", () => {
    const sent = original({ from: 'Me <ME@example.com>', to: 'bob@x.com, me@example.com, carol@x.com' });
    expect(replyRecipients(sent, 'me@example.com')).toEqual(['bob@x.com', 'carol@x.com']);
  });

  it('falls back to From for a note to self', () => {
    const note = original({ from: 'me@example.com', to: 'me@example.com' });
    expect(replyRecipients(note, 'me@example.com')).toEqual(['me@example.com']);
  });

  it('throws a readable error when there is nobody to reply to', () => {
    expect(() => buildReply(original({ from: '' }), 'hi')).toThrow(ReplyError);
  });
});

describe('replyReferences and threading', () => {
  it('starts a References chain from the Message-ID', () => {
    expect(replyReferences(original())).toEqual(['<orig@example.com>']);
  });

  it('does not duplicate a Message-ID already in References', () => {
    expect(replyReferences(original({ references: '<a@x> <orig@example.com>' }))).toEqual(['<a@x>', '<orig@example.com>']);
  });

  it('omits In-Reply-To and References when the original has no Message-ID', () => {
    const { headers } = decode(buildReply(original({ messageId: '' }), 'hi').raw);
    expect(headers.has('in-reply-to')).toBe(false);
    expect(headers.has('references')).toBe(false);
  });

  it('folds a long References header onto several lines', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `<message-${i}@mail.example.com>`).join(' ');
    const { headerBlock, headers } = decode(buildReply(original({ references: ids }), 'hi').raw);
    expect(Math.max(...headerBlock.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(78);
    expect(headers.get('references')?.split(' ')).toHaveLength(31);
  });
});

describe('header injection', () => {
  it('cannot add headers through a crafted subject, sender or Message-ID', () => {
    const evil = original({
      subject: 'Hi\r\nBcc: attacker@evil.example',
      from: 'Alice <alice@example.com>\nCc: attacker@evil.example',
      messageId: '<id@x>\r\nX-Injected: yes',
    });
    const { headers, headerBlock } = decode(buildReply(evil, 'hi').raw);
    expect(headers.has('bcc')).toBe(false);
    expect(headers.has('cc')).toBe(false);
    expect(headers.has('x-injected')).toBe(false);
    expect(headers.get('subject')).toBe('Re: Hi Bcc: attacker@evil.example');
    expect(headerBlock).not.toMatch(/\r\n(Bcc|Cc|X-Injected):/i);
  });
});

describe('non-ASCII headers', () => {
  it('encodes a non-ASCII subject as RFC 2047 words and leaves ASCII alone', () => {
    expect(encodeHeaderText('Plain subject')).toBe('Plain subject');
    const { headers } = decode(buildReply(original({ subject: 'Café crème 👍' }), 'hi').raw);
    expect(headers.get('subject')).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeWords(headers.get('subject') ?? '')).toBe('Re: Café crème 👍');
  });

  it('splits long subjects into words of at most 75 characters without breaking characters', () => {
    const subject = 'Überprüfung der Rechnung für das dritte Quartal 2026 — 日本語のテキスト 👍👍👍';
    const encoded = encodeHeaderText(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(decodeWords(word)).not.toContain('�');
    }
    expect(decodeWords(encoded)).toBe(subject);
  });

  it('encodes only the display name of an address', () => {
    const encoded = encodeAddress('"José Núñez" <jose@example.com>');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <jose@example\.com>$/);
    expect(decodeWords(encoded)).toBe('José Núñez <jose@example.com>');
    expect(encodeAddress('Alice <alice@example.com>')).toBe('Alice <alice@example.com>');
  });

  it('splits address lists only on commas outside quotes and angle brackets', () => {
    expect(splitAddresses('"Doe, Jane" <jane@x.com>, bob@y.com,  "A \\"B\\", C" <c@z.com>')).toEqual([
      '"Doe, Jane" <jane@x.com>',
      'bob@y.com',
      '"A \\"B\\", C" <c@z.com>',
    ]);
  });
});

describe('body encoding', () => {
  it('normalizes line endings to CRLF, keeps UTF-8 and wraps base64 at 76 characters', () => {
    const text = 'Line one\nLine two — ünïcödé 👍\n\n' + 'x'.repeat(300);
    const message = Buffer.from(buildReply(original(), text).raw, 'base64url').toString('utf8');
    const bodyLines = message.slice(message.indexOf('\r\n\r\n') + 4).trimEnd().split('\r\n');
    expect(Math.max(...bodyLines.map((l) => l.length))).toBeLessThanOrEqual(76);
    expect(decode(buildReply(original(), text).raw).body).toBe(text.replace(/\n/g, '\r\n'));
  });
});
