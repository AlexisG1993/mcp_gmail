/**
 * Builds an RFC 2822 reply for Gmail's `users.drafts.create`. Pure functions:
 * no network, no auth.
 *
 * Header values are copied from the original email, which a stranger wrote.
 * Every one is stripped of CR/LF so a crafted subject cannot inject extra
 * headers (such as a hidden Bcc) into the draft.
 */
import type { gmail_v1 } from 'googleapis';
import { getHeader } from './parse.js';

/** The parts of the original message a reply needs, as decoded header strings. */
export interface OriginalMessage {
  threadId: string;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  messageId: string;
  references: string;
}

/** Headers to request with `format: 'metadata'` when fetching the message being replied to. */
export const REPLY_HEADERS = ['From', 'Reply-To', 'To', 'Subject', 'Message-ID', 'References'];

export function originalFromMessage(message: gmail_v1.Schema$Message): OriginalMessage {
  const headers = message.payload?.headers;
  return {
    threadId: message.threadId ?? '',
    from: getHeader(headers, 'From'),
    replyTo: getHeader(headers, 'Reply-To'),
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    messageId: getHeader(headers, 'Message-ID'),
    references: getHeader(headers, 'References'),
  };
}

export interface ReplyDraft {
  /** The full message, base64url-encoded, ready for `message.raw`. */
  raw: string;
  threadId: string;
  /** Recipients as written into the To header, before encoding. */
  to: string;
  subject: string;
}

/** Thrown when the original message cannot be replied to. The message is safe to show. */
export class ReplyError extends Error {
  override readonly name = 'ReplyError';
}

/** Collapses line breaks so a value can only ever be a single header. */
export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Prefixes `Re: ` unless the subject already starts with "Re:" (any case, optional space before the colon). */
export function replySubject(subject: string): string {
  const clean = sanitizeHeader(subject);
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`.trimEnd();
}

/** Splits an address list on commas that are outside quotes and angle brackets. */
export function splitAddresses(list: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i] as string;
    if (ch === '\\' && quoted) {
      current += ch + (list[++i] ?? '');
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle = true;
    else if (!quoted && ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The bare, lower-cased email address from `Name <addr>` or `addr`. */
export function emailOf(address: string): string {
  return (/<([^>]*)>/.exec(address)?.[1] ?? address).trim().toLowerCase();
}

/**
 * Chooses who the reply goes to:
 * - the original Reply-To if set, otherwise From (what every mail client does);
 * - but if the original was sent by the user, its To recipients, so replying
 *   to your own sent message continues the conversation instead of mailing yourself.
 */
export function replyRecipients(original: OriginalMessage, selfAddress?: string): string[] {
  const from = splitAddresses(sanitizeHeader(original.from));
  const self = selfAddress?.toLowerCase();
  if (self && from.length > 0 && from.every((a) => emailOf(a) === self)) {
    const to = splitAddresses(sanitizeHeader(original.to)).filter((a) => emailOf(a) !== self);
    if (to.length > 0) return to;
  }
  const replyTo = splitAddresses(sanitizeHeader(original.replyTo));
  return replyTo.length > 0 ? replyTo : from;
}

/** New References value: the original's References plus its Message-ID, without duplicates. */
export function replyReferences(original: OriginalMessage): string[] {
  const ids = sanitizeHeader(original.references).split(/\s+/).filter(Boolean);
  const messageId = sanitizeHeader(original.messageId);
  if (messageId && !ids.includes(messageId)) ids.push(messageId);
  return ids;
}

const ASCII = /^[\x20-\x7e]*$/;

/**
 * RFC 2047 encoded words for non-ASCII header text, e.g. `=?UTF-8?B?Q2Fmw6k=?=`.
 * Long text is split into several words (each at most 75 characters, never
 * splitting a character) joined by header folding.
 */
export function encodeHeaderText(text: string): string {
  if (ASCII.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const char of text) {
    // 45 bytes of UTF-8 -> 60 base64 characters + 12 for "=?UTF-8?B?" and "?=".
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

/** Encodes a non-ASCII display name in `Name <addr>`, leaving the address itself untouched. */
export function encodeAddress(address: string): string {
  if (ASCII.test(address)) return address;
  const match = /^(.*?)\s*<([^>]+)>$/.exec(address);
  if (!match) return address;
  const name = (match[1] ?? '').replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');
  return `${encodeHeaderText(name)} <${match[2]}>`;
}

/** Base64 body in 76-character lines, as MIME requires. */
function encodeBody(body: string): string {
  const crlf = body.replace(/\r?\n/g, '\r\n');
  return (Buffer.from(crlf, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * Builds a plain-text reply to `original`. Gmail adds From and Date itself
 * from the signed-in account. Replies go to the sender only (not reply-all).
 */
export function buildReply(original: OriginalMessage, body: string, selfAddress?: string): ReplyDraft {
  const recipients = replyRecipients(original, selfAddress);
  if (recipients.length === 0) throw new ReplyError('The original email has no sender address to reply to.');

  const subject = replySubject(original.subject);
  const messageId = sanitizeHeader(original.messageId);
  const references = replyReferences(original);

  const headers = [
    `To: ${recipients.map(encodeAddress).join(', ')}`,
    `Subject: ${encodeHeaderText(subject)}`,
  ];
  // Without a Message-ID there is nothing to point at; threadId still keeps it in the Gmail thread.
  if (messageId) headers.push(`In-Reply-To: ${messageId}`);
  if (references.length > 0) headers.push(`References: ${references.join('\r\n ')}`);
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');

  const message = `${headers.join('\r\n')}\r\n\r\n${encodeBody(body)}\r\n`;
  return {
    raw: Buffer.from(message, 'utf8').toString('base64url'),
    threadId: original.threadId,
    to: recipients.join(', '),
    subject,
  };
}
