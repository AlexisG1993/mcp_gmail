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

/**
 * Each decoded text part is cut to this length before any conversion runs, so a
 * huge or hostile message costs bounded time no matter what it contains.
 */
export const MAX_SOURCE_CHARS = 500_000;

/** Total body characters a thread may return; the newest messages get the budget first. */
export const MAX_THREAD_CHARS = 60_000;

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
  replyTo: string;
  /** SPF, DKIM and DMARC verdicts from Gmail's Authentication-Results header, e.g. "spf=pass dkim=pass dmarc=pass". */
  authentication: string;
  subject: string;
  date: string;
  messageId: string;
  body: string;
  /** Length of the full body before truncation. */
  bodyLength: number;
  truncated: boolean;
  attachments: Attachment[];
  /** Warnings about how the body was produced, e.g. hidden HTML text. */
  notes: string[];
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
  capped: boolean;
}

function capSource(text: string, out: Collected): string {
  if (text.length <= MAX_SOURCE_CHARS) return text;
  out.capped = true;
  return text.slice(0, MAX_SOURCE_CHARS);
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
  if (mimeType === 'text/plain') out.plain.push(capSource(decodeText(decodeBase64Url(data), contentType), out));
  else if (mimeType === 'text/html') out.html.push(capSource(decodeText(decodeBase64Url(data), contentType), out));
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

// Tag attributes, allowing ">" inside quoted values (title="a>b"). A quoted
// value cannot run past the next "<", which keeps every match linear.
const ATTRS = String.raw`(?:[^<>"']|"[^"<]*"|'[^'<]*')*`;
const tag = (body: string, flags = 'gi') => new RegExp(`<${body}`, flags);

const LINK_TAG = tag(`a\\b(${ATTRS})>|<\\/a\\s*>`);
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i;

/**
 * Writes each link's target after its text, as in "Pay now (https://…)", so the
 * model can see where a link really goes. Single pass, linear in the input.
 */
function inlineLinks(html: string): string {
  let out = '';
  let last = 0;
  let open: { href: string; start: number } | undefined;
  for (const m of html.matchAll(LINK_TAG)) {
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const h = HREF.exec(m[1]);
      // Entities are decoded first, so "&#104;ttps://" is recognized as https.
      const href = decodeEntities(h?.[1] ?? h?.[2] ?? h?.[3] ?? '').trim();
      open = /^(https?:|mailto:|\/\/)/i.test(href) ? { href: href.replace(/^mailto:/i, ''), start: out.length } : undefined;
    } else if (open) {
      const text = decodeEntities(out.slice(open.start).replace(ANY_TAG, '')).trim();
      // Entities in the target are left encoded; the final decode pass in htmlToText handles them once.
      if (text !== open.href) out += ` (${open.href.replace(/&/g, '&amp;')})`;
      open = undefined;
    }
  }
  return out + html.slice(last);
}

const ANY_TAG = tag(`${ATTRS}>`, 'g');
const OPEN_TAG = tag(`([a-z][a-z0-9]*)\\b(${ATTRS})>`);
const STYLE_ATTR = /\bstyle\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gi;
const HIDDEN_ATTR = /(?:^|\s)hidden(?=[\s/=]|$)/i;
const VOID_ELEMENTS = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'wbr', 'source', 'area', 'col']);
const MAX_HIDDEN_MARKS = 200;

// Declarations that hide text from a human reader while it stays in the markup.
const HIDING_DECLARATION =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|(?:font-size|max-height|height|width)\s*:\s*0(?:[a-z%]*)?\s*(?:!important)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:!important)?\s*(?:;|$))/i;

function cssValue(style: string, property: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(style);
  return m?.[1]?.trim().toLowerCase().replace(/\s+/g, '').replace(/!important$/, '');
}

/**
 * True when a tag's attributes hide its content from a person: the `hidden`
 * attribute, display or visibility off, zero size or opacity, or text in the
 * same colour as its own background. Only inline styles are checked.
 */
function hidesContent(attrs: string): boolean {
  if (HIDDEN_ATTR.test(attrs)) return true;
  for (const m of attrs.matchAll(STYLE_ATTR)) {
    const style = m[1] ?? m[2] ?? '';
    if (HIDING_DECLARATION.test(style)) return true;
    const color = cssValue(style, 'color');
    const background = cssValue(style, 'background-color') ?? cssValue(style, 'background');
    if (color !== undefined && color === background) return true;
  }
  return false;
}

/** True when the HTML contains an element whose text a person cannot see. */
export function hasHiddenHtml(html: string): boolean {
  for (const m of html.matchAll(OPEN_TAG)) {
    if (!VOID_ELEMENTS.has((m[1] as string).toLowerCase()) && hidesContent(m[2] as string)) return true;
  }
  return false;
}

/**
 * Wraps the content of hidden elements in "[hidden text: …]", so the model can
 * tell which words a person reading the email would never see. The element is
 * taken to end at the next closing tag of the same name, which is right for the
 * usual single-element case. At most MAX_HIDDEN_MARKS elements are marked, and
 * a tag name with no closing tag is not searched again, so the cost stays linear.
 */
function markHidden(html: string): string {
  const lower = html.toLowerCase();
  const unclosed = new Set<string>();
  let out = '';
  let last = 0;
  let marks = 0;
  for (const m of html.matchAll(OPEN_TAG)) {
    if (marks >= MAX_HIDDEN_MARKS) break;
    if (m.index < last) continue; // inside an element already marked
    const name = (m[1] as string).toLowerCase();
    if (VOID_ELEMENTS.has(name) || unclosed.has(name) || !hidesContent(m[2] as string)) continue;
    const contentStart = m.index + m[0].length;
    const end = lower.indexOf(`</${name}`, contentStart);
    if (end < 0) {
      unclosed.add(name);
      continue;
    }
    out += `${html.slice(last, contentStart)} [hidden text: ${html.slice(contentStart, end)}] `;
    last = end;
    marks++;
  }
  return out + html.slice(last);
}

/**
 * A deliberately light HTML-to-text conversion: drops non-content elements,
 * turns block boundaries into line breaks, marks hidden text, keeps link
 * targets, strips the remaining tags and decodes entities. Good enough for an
 * LLM to read; not a renderer.
 *
 * Every pattern runs in linear time: none can scan past the next "<", and the
 * unterminated cases match to the end instead of rescanning. Hostile input such
 * as thousands of unclosed "<" therefore cannot stall the server.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    inlineLinks(
      markHidden(
        html
          .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
          .replace(/<(head|style|script|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ''),
      ),
    )
      .replace(/<br\s*\/?>/gi, '\n')
      // List items and table rows start a line; their closing tags add nothing,
      // so consecutive items do not get blank lines between them.
      .replace(tag(`li\\b${ATTRS}>`), '\n- ')
      .replace(/<\/(p|div|ul|ol|table|blockquote|h[1-6])\s*>/gi, '\n')
      .replace(tag(`(?:p|div|tr|table|blockquote|h[1-6])\\b${ATTRS}>`), '\n')
      .replace(/<\/t[dh]\s*>/gi, '\t')
      .replace(ANY_TAG, '')
      // Anything left is a malformed tag, such as one with an unbalanced quote.
      .replace(/<[^<>]*>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts the readable body and attachment metadata.
 *
 * Plain text is preferred because it is what the sender wrote for text readers.
 * When the plain part is only a stub of the HTML (a "view in browser" line, or
 * a footer next to an HTML-only body), the HTML version is used instead, since
 * that is what a person sees in Gmail. Notes record anything the reader should
 * know about how the body was produced.
 */
export function extractBody(payload: MessagePart | null | undefined): {
  text: string;
  attachments: Attachment[];
  notes: string[];
} {
  const out: Collected = { plain: [], html: [], attachments: [], capped: false };
  if (payload) walk(payload, out);
  const notes: string[] = [];

  const plain = out.plain
    .join('\n\n')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd()) // trailing spaces, e.g. from format=flowed line wrapping
    .join('\n')
    .trim();
  const html = out.html.map(htmlToText).join('\n\n');

  let text = plain || html;
  if (plain && html.length > 2 * plain.length) {
    text = html;
    notes.push('The plain-text part is much shorter than the HTML part, so the HTML version is shown.');
  } else if (plain && html && versionsDiffer(plain, html)) {
    // A sender can put harmless text in the plain part and something else in
    // the HTML a person sees. Showing both keeps the model from being blind to it.
    text = `${plain}\n\n--- HTML version ---\n\n${html}`;
    notes.push('The plain-text and HTML versions differ in content, so both are shown. A person reading in Gmail sees the HTML version.');
  }
  if (out.html.some(hasHiddenHtml)) {
    notes.push('The HTML contains hidden elements; their text is included here, but a person reading in Gmail may not see it.');
  }
  if (out.capped) notes.push(`Part of the message exceeded ${MAX_SOURCE_CHARS} characters and was cut before conversion.`);
  return { text, attachments: out.attachments, notes };
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
}

/** True when the HTML version has substantial wording the plain version lacks. */
function versionsDiffer(plain: string, html: string): boolean {
  const plainWords = words(plain);
  const htmlWords = [...words(html)];
  const missing = htmlWords.filter((w) => !plainWords.has(w)).length;
  return missing >= 5 && missing > 0.3 * htmlWords.length;
}

export interface AuthResult {
  method: 'spf' | 'dkim' | 'dmarc';
  result: string;
  /** The domain the result applies to: DKIM signer, SPF envelope sender or DMARC From domain. */
  domain: string;
}

// The property that names the authenticated domain, per method.
const AUTH_DOMAIN_PROPS = {
  dkim: ['header.d', 'header.i'],
  spf: ['smtp.mailfrom', 'smtp.helo'],
  dmarc: ['header.from'],
} as const;

/**
 * Parses the Authentication-Results header Gmail adds on receipt (RFC 8601).
 * Only a header whose authserv-id is mx.google.com is read, and Gmail puts its
 * own above any the sender included, so the first such header is Gmail's.
 * Comments in parentheses are removed before parsing, so text such as
 * "smtp.mailfrom=dmarc=pass@evil.example" cannot pose as a verdict.
 */
export function parseAuthResults(headers: Header[] | null | undefined): AuthResult[] {
  const header = (headers ?? []).find(
    (h) => h.name?.toLowerCase() === 'authentication-results' && /^\s*mx\.google\.com\s*;/i.test(h.value ?? ''),
  );
  let value = (header?.value ?? '').slice(0, 5_000);
  for (let i = 0; i < 5 && /\([^()]*\)/.test(value); i++) value = value.replace(/\([^()]*\)/g, ' ');

  const results: AuthResult[] = [];
  for (const resinfo of value.split(';').slice(1)) {
    const m = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)\b(.*)$/is.exec(resinfo);
    if (!m) continue;
    const method = (m[1] as string).toLowerCase() as AuthResult['method'];
    const props = new Map(
      [...(m[3] as string).matchAll(/\b([a-z]+\.[a-z-]+)\s*=\s*("[^"]*"|\S+)/gi)].map((p) => [
        (p[1] as string).toLowerCase(),
        (p[2] as string).replace(/"/g, ''),
      ]),
    );
    const raw = AUTH_DOMAIN_PROPS[method].map((k) => props.get(k)).find(Boolean) ?? '';
    results.push({ method, result: (m[2] as string).toLowerCase(), domain: raw.replace(/^.*@/, '').toLowerCase() });
  }
  return results;
}

/** Compact verdicts with their domains, e.g. "spf=pass (evil.example) dkim=pass (evil.example) dmarc=fail (bank.example)". */
export function authenticationSummary(headers: Header[] | null | undefined): string {
  return parseAuthResults(headers)
    .map((r) => `${r.method}=${r.result}${r.domain ? ` (${r.domain})` : ''}`)
    .join(' ');
}

/** A warning when the From domain is not the one that authenticated, the core of most spoofing. */
function authenticationNote(headers: Header[] | null | undefined): string | undefined {
  const results = parseAuthResults(headers);
  if (results.length === 0) return undefined;
  const fromDomain = /@([^>\s]+)/.exec(getHeader(headers, 'From'))?.[1]?.toLowerCase() ?? '';
  const dmarc = results.find((r) => r.method === 'dmarc');
  if (dmarc?.result === 'pass') return undefined;
  return `The From domain${fromDomain ? ` (${fromDomain})` : ''} is not authenticated: DMARC ${dmarc?.result ?? 'has no result'}.`;
}

export function truncate(text: string, max = MAX_BODY_CHARS): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** Parses a message fetched with `format: 'full'`. */
export function parseMessage(message: Message): ParsedEmail {
  const headers = message.payload?.headers;
  const { text, attachments, notes } = extractBody(message.payload);
  const authNote = authenticationNote(headers);
  if (authNote) notes.unshift(authNote);
  const body = truncate(text);
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    replyTo: getHeader(headers, 'Reply-To'),
    authentication: authenticationSummary(headers),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    messageId: getHeader(headers, 'Message-ID'),
    body: body.text,
    bodyLength: text.length,
    truncated: body.truncated,
    attachments,
    notes,
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
  // Replies go to Reply-To when it is set, so a mismatch with From is worth seeing before drafting.
  if (email.replyTo) lines.push(`Reply-To: ${email.replyTo}`);
  lines.push(`Subject: ${email.subject}`, `Date: ${email.date}`, `Message-ID header: ${email.messageId}`);
  lines.push(`Sender authentication: ${email.authentication || 'no results'}`);

  if (email.attachments.length > 0) {
    lines.push('Attachments (metadata only):');
    for (const a of email.attachments) lines.push(`- ${a.filename} (${a.mimeType}, ${formatSize(a.size)})`);
  } else {
    lines.push('Attachments: none');
  }

  for (const note of email.notes) lines.push(`Note: ${note}`);

  if (email.truncated && email.body.length === 0) {
    lines.push('', `[Body omitted to keep the thread within its size limit. Read it with get_email: ${email.id}]`);
    return lines.join('\n');
  }
  lines.push('', email.body || '(no readable body)');
  if (email.truncated) {
    lines.push('', `[Body truncated: showing the first ${email.body.length} of ${email.bodyLength} characters.]`);
  }
  return lines.join('\n');
}

export function formatSummaries(summaries: EmailSummary[], query: string, skipped = 0): string {
  if (summaries.length === 0) return `No messages match "${query}".`;
  const skippedNote = skipped > 0 ? `\n\n${skipped} more match(es) could not be loaded and were skipped.` : '';
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
  return [`${summaries.length} message(s) matching "${query}":`, '', blocks.join('\n\n')].join('\n') + skippedNote;
}

/**
 * Caps a thread's total body size. Newest messages are kept first, since they
 * carry the latest state of the conversation; older ones are shortened, then
 * omitted with a pointer to get_email.
 */
export function fitThreadBudget(emails: ParsedEmail[], budget = MAX_THREAD_CHARS): ParsedEmail[] {
  let remaining = budget;
  const fitted = [...emails];
  for (let i = fitted.length - 1; i >= 0; i--) {
    const email = fitted[i] as ParsedEmail;
    const body = email.body.length > remaining ? email.body.slice(0, remaining) : email.body;
    if (body !== email.body) fitted[i] = { ...email, body, truncated: true };
    remaining -= body.length;
  }
  return fitted;
}

export function formatThread(threadId: string, emails: ParsedEmail[]): string {
  const header = `Thread ${threadId}: ${emails.length} message(s), oldest first.`;
  const blocks = emails.map((e, i) => `=== Message ${i + 1} of ${emails.length} ===\n${formatEmail(e)}`);
  return [header, '', blocks.join('\n\n')].join('\n');
}
