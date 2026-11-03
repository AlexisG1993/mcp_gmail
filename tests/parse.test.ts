import { readFileSync } from 'node:fs';
import type { gmail_v1 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_CHARS,
  decodeBase64Url,
  decodeEntities,
  extractBody,
  formatEmail,
  formatSummaries,
  formatThread,
  getHeader,
  htmlToText,
  parseMessage,
  sortOldestFirst,
  summarizeMessage,
} from '../src/gmail/parse.js';

function fixture<T = gmail_v1.Schema$Message>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

function plainMessage(text: string): gmail_v1.Schema$Message {
  return {
    id: 'm-big',
    threadId: 't-big',
    payload: { mimeType: 'text/plain', headers: [], body: { data: Buffer.from(text).toString('base64url') } },
  };
}

describe('decodeBase64Url', () => {
  it('decodes unpadded input of every length remainder', () => {
    expect(decodeBase64Url('YQ').toString()).toBe('a');
    expect(decodeBase64Url('YWI').toString()).toBe('ab');
    expect(decodeBase64Url('YWJj').toString()).toBe('abc');
  });

  it('accepts padded input', () => {
    expect(decodeBase64Url('YQ==').toString()).toBe('a');
    expect(decodeBase64Url('YWI=').toString()).toBe('ab');
  });

  it('decodes the URL-safe characters - and _', () => {
    expect(decodeBase64Url('Pj4-').toString()).toBe('>>>');
    expect(decodeBase64Url('Pz8_').toString()).toBe('???');
  });

  it('also accepts the standard + and / alphabet', () => {
    expect(decodeBase64Url('Pj4+').toString()).toBe('>>>');
    expect(decodeBase64Url('Pz8/').toString()).toBe('???');
  });

  it('round-trips multi-byte UTF-8', () => {
    const text = '日本語のテキスト 👍 café';
    expect(decodeBase64Url(Buffer.from(text).toString('base64url')).toString('utf8')).toBe(text);
  });

  it('returns an empty buffer for an empty string', () => {
    expect(decodeBase64Url('').length).toBe(0);
  });
});

describe('getHeader', () => {
  it('matches header names case-insensitively and returns "" when absent', () => {
    const headers = [{ name: 'message-id', value: '<x@y>' }];
    expect(getHeader(headers, 'Message-ID')).toBe('<x@y>');
    expect(getHeader(headers, 'Cc')).toBe('');
    expect(getHeader(undefined, 'From')).toBe('');
  });
});

describe('parseMessage', () => {
  it('reads a plain-text-only message and normalizes CRLF', () => {
    const email = parseMessage(fixture('plain-only.json'));
    expect(email).toMatchObject({
      id: 'm-plain',
      threadId: 't-100',
      from: 'Alice Example <alice@example.com>',
      to: 'me@example.com',
      cc: '',
      subject: 'Quarterly invoice',
      date: 'Mon, 2 Nov 2026 09:15:00 +0000',
      messageId: '<CAF1234@mail.example.com>',
      truncated: false,
      attachments: [],
    });
    expect(email.body).toBe('Hi,\n\nPlease find the invoice details below.\n\nThanks,\nAlice');
  });

  it('converts an HTML-only message to readable text', () => {
    const { body } = parseMessage(fixture('html-only.json'));
    expect(body).toContain('Hello Bob,');
    expect(body).toContain('Your order #42 has shipped & is on its way.');
    expect(body).toContain('- Item one\n- Item two');
    expect(body).toContain("Questions? Reply's welcome.\nLine two — done");
    expect(body).not.toMatch(/[<>]/);
    expect(body).not.toContain('color:red');
    expect(body).not.toContain('alert(1)');
    expect(body).not.toContain('tracking');
  });

  it('prefers text/plain inside multipart/alternative', () => {
    expect(parseMessage(fixture('multipart-alternative.json')).body).toBe('Plain version wins.');
  });

  it('finds the body in nested multiparts and lists attachments as metadata only', () => {
    const email = parseMessage(fixture('nested-with-attachment.json'));
    expect(email.body).toBe('See the attached invoice. Total: 1 200 €. 👍');
    expect(email.cc).toBe('Carol <carol@example.com>');
    expect(email.attachments).toEqual([
      { filename: 'logo.png', mimeType: 'image/png', size: 2048 },
      { filename: 'invoice-2026-11.pdf', mimeType: 'application/pdf', size: 183500 },
    ]);
  });

  it('decodes the declared charset, not just UTF-8', () => {
    expect(parseMessage(fixture('latin1.json')).body).toBe('Café crème');
  });

  it('lists an attached email as an attachment instead of inlining it', () => {
    const { text, attachments } = extractBody({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Forwarding this.').toString('base64url') } },
        {
          mimeType: 'message/rfc822',
          filename: 'original.eml',
          body: { size: 900 },
          parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Inner text').toString('base64url') } }],
        },
      ],
    });
    expect(text).toBe('Forwarding this.');
    expect(attachments).toEqual([{ filename: 'original.eml', mimeType: 'message/rfc822', size: 900 }]);
  });

  it('strips trailing spaces from plain-text lines', () => {
    expect(parseMessage(plainMessage('Wrapped line  \r\ncontinues here.\t\r\n')).body).toBe(
      'Wrapped line\ncontinues here.',
    );
  });

  it('strips a hostile run of spaces in linear time', () => {
    const started = Date.now();
    parseMessage(plainMessage(`a${' '.repeat(400_000)}b`));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('handles a message with no payload', () => {
    const email = parseMessage({ id: 'm-empty', threadId: 't-empty' });
    expect(email.body).toBe('');
    expect(formatEmail(email)).toContain('(no readable body)');
  });
});

describe('truncation', () => {
  it(`keeps a body of exactly ${MAX_BODY_CHARS} characters intact`, () => {
    const email = parseMessage(plainMessage('x'.repeat(MAX_BODY_CHARS)));
    expect(email.truncated).toBe(false);
    expect(formatEmail(email)).not.toContain('[Body truncated');
  });

  it('cuts longer bodies and says so in the output', () => {
    const email = parseMessage(plainMessage('y'.repeat(25_000)));
    expect(email.truncated).toBe(true);
    expect(email.body).toHaveLength(MAX_BODY_CHARS);
    expect(email.bodyLength).toBe(25_000);
    expect(formatEmail(email)).toContain('[Body truncated: showing the first 20000 of 25000 characters.]');
  });
});

describe('htmlToText and decodeEntities', () => {
  it('separates table cells with spaces and rows with line breaks', () => {
    expect(htmlToText('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>')).toBe('A B\nC D');
  });

  it('keeps link targets, but not when the text already is the target', () => {
    expect(htmlToText('<a href="https://pay.example/x"><b>Pay now</b></a>')).toBe('Pay now (https://pay.example/x)');
    expect(htmlToText("<a href='mailto:a@b.example'>a@b.example</a>")).toBe('a@b.example');
    expect(htmlToText('<a href="https://x.example">https://x.example</a>')).toBe('https://x.example');
    expect(htmlToText('<a href="javascript:alert(1)">Click</a>')).toBe('Click');
  });

  it('drops unterminated comments and scripts to the end, like a browser', () => {
    expect(htmlToText('Visible<!-- never closed <p>hidden')).toBe('Visible');
    expect(htmlToText('Visible<script>never closed')).toBe('Visible');
  });

  it.each([
    ['unclosed <', '<'.repeat(400_000)],
    ['unclosed <li', '<li'.repeat(150_000)],
    ['unclosed comments', '<!--'.repeat(100_000)],
    ['unclosed <style', '<style'.repeat(70_000)],
    ['open links', '<a href="https://x">'.repeat(20_000)],
  ])('converts hostile HTML (%s) in linear time', (_label, html) => {
    const started = Date.now();
    htmlToText(html);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('leaves unknown or invalid entities untouched', () => {
    expect(decodeEntities('&bogus; &#0; &#x110000; &#65;&#x42;')).toBe('&bogus; &#0; &#x110000; AB');
  });
});

describe('summaries', () => {
  it('summarizes a metadata-format message and decodes the snippet', () => {
    expect(summarizeMessage(fixture('metadata.json'))).toEqual({
      id: 'm-meta',
      threadId: 't-200',
      from: 'Support <support@vendor.example>',
      to: 'me@example.com',
      subject: 'Ticket #123',
      date: 'Sun, 1 Nov 2026 18:00:00 +0000',
      snippet: "We've received your request & will reply soon",
      labelIds: ['INBOX', 'CATEGORY_UPDATES'],
    });
  });

  it('formats a result list and an empty result', () => {
    const text = formatSummaries([summarizeMessage(fixture('metadata.json'))], 'in:inbox');
    expect(text).toContain('1 message(s) matching "in:inbox"');
    expect(text).toContain('id: m-meta');
    expect(text).toContain('labels: INBOX, CATEGORY_UPDATES');
    expect(formatSummaries([], 'from:nobody')).toBe('No messages match "from:nobody".');
  });
});

describe('formatEmail', () => {
  it('includes headers and attachment metadata', () => {
    const text = formatEmail(parseMessage(fixture('nested-with-attachment.json')));
    expect(text).toContain('Message-ID header: <CAF1234@mail.example.com>');
    expect(text).toContain('Cc: Carol <carol@example.com>');
    expect(text).toContain('Attachments (metadata only):');
    expect(text).toContain('- invoice-2026-11.pdf (application/pdf, 179.2 KB)');
    expect(text).toContain('- logo.png (image/png, 2.0 KB)');
  });
});

describe('threads', () => {
  it('orders messages oldest first', () => {
    const thread = fixture<gmail_v1.Schema$Thread>('thread.json');
    const sorted = sortOldestFirst(thread.messages ?? []);
    expect(sorted.map((m) => m.id)).toEqual(['m-1', 'm-2']);

    const text = formatThread('t-100', sorted.map(parseMessage));
    expect(text.startsWith('Thread t-100: 2 message(s), oldest first.')).toBe(true);
    expect(text.indexOf('First message.')).toBeLessThan(text.indexOf('Second message (reply).'));
  });
});
