/**
 * Turns Gmail API message resources into plain, LLM-friendly text.
 *
 * Pure functions only: no network, no auth. The input types are the ones
 * googleapis returns for `users.messages.get` and `users.threads.get`.
 */
import type { gmail_v1 } from 'googleapis';

type Message = gmail_v1.Schema$Message;
type MessagePart = gmail_v1.Schema$MessagePart;
type Header = gmail_v1.Schema$MessagePartHeader;

/** Bodies longer than this are cut, and the output says so. */
export const MAX_BODY_CHARS = 20_000;

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  messageId: string;
  body: string;
  /** Length of the full body before truncation. */
  bodyLength: number;
  truncated: boolean;
  attachments: Attachment[];
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

/** Case-insensitive header lookup. Returns '' when the header is absent. */
export function getHeader(headers: Header[] | null | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === wanted)?.value ?? '';
}

/**
 * Decodes a Gmail body string to bytes. Gmail uses base64url (`-` and `_`,
 * usually unpadded). Node's base64url decoder also accepts padding and the
 * standard `+` `/` alphabet, so all variants seen in the wild decode the same.
 */
export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data, 'base64url');
}

/**
 * Decodes body bytes using the part's declared charset (for example
 * `text/plain; charset="iso-8859-1"`). Gmail has already undone the transfer
 * encoding (base64 or quoted-printable) but not the charset. Unknown charsets
 * fall back to UTF-8.
 */
function decodeText(bytes: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** A part is an attachment if it has a filename or is marked `Content-Disposition: attachment`. */
function isAttachment(part: MessagePart): boolean {
  return Boolean(part.filename) || /^\s*attachment/i.test(getHeader(part.headers, 'Content-Disposition'));
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: Attachment[];
}

/**
 * Walks the MIME tree depth-first, in document order. Every inline text/plain
 * and text/html leaf is collected, so a multipart/mixed message whose text is
 * split around an attachment keeps all of its text. Inside multipart/alternative
 * both versions are collected; the caller then prefers plain over HTML.
 */
function walk(part: MessagePart, out: Collected): void {
  const mimeType = (part.mimeType ?? '').toLowerCase();

  // Checked before recursing, so an attached .eml (message/rfc822 with a
  // filename) is listed as an attachment rather than inlined.
  if (isAttachment(part)) {
    out.attachments.push({
      filename: part.filename || '(unnamed)',
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body?.size ?? 0,
    });
    return;
  }

  if (part.parts?.length) {
    for (const child of part.parts) walk(child, out);
    return;
  }

  const data = part.body?.data;
  if (!data) return;
  const contentType = getHeader(part.headers, 'Content-Type') || mimeType;
  if (mimeType === 'text/plain') out.plain.push(decodeText(decodeBase64Url(data), contentType));
  else if (mimeType === 'text/html') out.html.push(decodeText(decodeBase64Url(data), contentType));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
};

/** Decodes numeric entities and the common named ones. Unknown named entities are left as is. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * A deliberately light HTML-to-text conversion: drops non-content elements,
 * turns block boundaries into line breaks, strips the remaining tags and
 * decodes entities. Good enough for an LLM to read; not a renderer.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      // List items and table rows start a line; their closing tags add nothing,
      // so consecutive items do not get blank lines between them.
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|ul|ol|table|blockquote|h[1-6])\s*>/gi, '\n')
      .replace(/<(p|div|tr|table|blockquote|h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]\s*>/gi, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extracts the readable body (plain text preferred, HTML as fallback) and attachment metadata. */
export function extractBody(payload: MessagePart | null | undefined): { text: string; attachments: Attachment[] } {
  const out: Collected = { plain: [], html: [], attachments: [] };
  if (payload) walk(payload, out);
  const text =
    out.plain.length > 0
      ? out.plain
          .join('\n\n')
          .replace(/\r\n/g, '\n')
          .replace(/[ \t]+$/gm, '') // trailing spaces, e.g. from format=flowed line wrapping
          .trim()
      : out.html.map(htmlToText).join('\n\n');
  return { text, attachments: out.attachments };
}

export function truncate(text: string, max = MAX_BODY_CHARS): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** Parses a message fetched with `format: 'full'`. */
export function parseMessage(message: Message): ParsedEmail {
  const headers = message.payload?.headers;
  const { text, attachments } = extractBody(message.payload);
  const body = truncate(text);
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    messageId: getHeader(headers, 'Message-ID'),
    body: body.text,
    bodyLength: text.length,
    truncated: body.truncated,
    attachments,
  };
}

/** Summarizes a message fetched with `format: 'metadata'`. Gmail HTML-escapes snippets, so they are decoded. */
export function summarizeMessage(message: Message): EmailSummary {
  const headers = message.payload?.headers;
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    snippet: decodeEntities(message.snippet ?? ''),
    labelIds: message.labelIds ?? [],
  };
}

/** Thread messages oldest first, by Gmail's internal receive time. */
export function sortOldestFirst(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatEmail(email: ParsedEmail): string {
  const lines = [
    `Message ID: ${email.id}`,
    `Thread ID: ${email.threadId}`,
    `From: ${email.from}`,
    `To: ${email.to}`,
  ];
  if (email.cc) lines.push(`Cc: ${email.cc}`);
  lines.push(`Subject: ${email.subject}`, `Date: ${email.date}`, `Message-ID header: ${email.messageId}`);

  if (email.attachments.length > 0) {
    lines.push('Attachments (metadata only):');
    for (const a of email.attachments) lines.push(`- ${a.filename} (${a.mimeType}, ${formatSize(a.size)})`);
  } else {
    lines.push('Attachments: none');
  }

  lines.push('', email.body || '(no readable body)');
  if (email.truncated) {
    lines.push('', `[Body truncated: showing the first ${email.body.length} of ${email.bodyLength} characters.]`);
  }
  return lines.join('\n');
}

export function formatSummaries(summaries: EmailSummary[], query: string): string {
  if (summaries.length === 0) return `No messages match "${query}".`;
  const blocks = summaries.map((s, i) =>
    [
      `${i + 1}. ${s.subject || '(no subject)'}`,
      `   id: ${s.id}`,
      `   threadId: ${s.threadId}`,
      `   from: ${s.from}`,
      `   to: ${s.to}`,
      `   date: ${s.date}`,
      `   labels: ${s.labelIds.join(', ') || '(none)'}`,
      `   snippet: ${s.snippet}`,
    ].join('\n'),
  );
  return [`${summaries.length} message(s) matching "${query}":`, '', blocks.join('\n\n')].join('\n');
}

export function formatThread(threadId: string, emails: ParsedEmail[]): string {
  const header = `Thread ${threadId}: ${emails.length} message(s), oldest first.`;
  const blocks = emails.map((e, i) => `=== Message ${i + 1} of ${emails.length} ===\n${formatEmail(e)}`);
  return [header, '', blocks.join('\n\n')].join('\n');
}
