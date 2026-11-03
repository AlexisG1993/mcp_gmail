import { McpServer } from '@modelcontextprotocol/server';
import type { gmail_v1 } from 'googleapis';
import { z } from 'zod';
import { asAuthError, getGmail, withRetry } from './gmail/client.js';
import { REPLY_HEADERS, ReplyError, buildReply, originalFromMessage } from './gmail/draft.js';
import { describeGmailError } from './gmail/errors.js';
import {
  fitThreadBudget,
  formatEmail,
  formatSummaries,
  formatThread,
  parseMessage,
  sortOldestFirst,
  summarizeMessage,
} from './gmail/parse.js';
import { log } from './log.js';

const SERVER_NAME = 'gmail-mcp-server';
const SERVER_VERSION = '0.1.0';

// Gmail message and thread ids are short hex strings. Rejecting anything else
// up front gives the model a clear validation error instead of a Gmail 400.
const gmailId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Expected a Gmail id: letters, digits, "-" or "_".');

// Schemas are exported so their validation rules can be tested without a server.
export const searchEmailsInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .default('in:inbox')
    .describe('Gmail search syntax, e.g. "from:alice is:unread newer_than:7d". Defaults to "in:inbox".'),
  max_results: z.number().int().min(1).max(25).default(10).describe('How many messages to return, 1 to 25.'),
});

export const getEmailInput = z.object({
  message_id: gmailId.describe('Message id, as returned by search_emails.'),
});

export const getThreadInput = z.object({
  thread_id: gmailId.describe('Thread id, as returned by search_emails or get_email.'),
});

export const createDraftReplyInput = z.object({
  message_id: gmailId.describe('Id of the email being replied to, as returned by search_emails or get_email.'),
  body: z
    .string()
    .max(50_000)
    .refine((text) => text.trim().length > 0, 'The reply body must not be empty.')
    .describe('Plain-text body of the reply. It is saved as a draft and never sent.'),
});

// Structured search results, so agent code can use ids without parsing display text.
export const searchEmailsOutput = z.object({
  query: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      threadId: z.string(),
      from: z.string(),
      to: z.string(),
      subject: z.string(),
      date: z.string(),
      snippet: z.string(),
      labels: z.array(z.string()),
    }),
  ),
  skipped: z.number().int().describe('Matches that could not be loaded, e.g. deleted after the search ran.'),
});

type GmailProvider = () => Promise<gmail_v1.Gmail>;

/**
 * Builds the MCP server and registers its tools. The Gmail client is injected
 * so tests can pass a fake; the default loads the saved sign-in on first use.
 */
export function createServer(gmail: GmailProvider = () => getGmail()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'search_emails',
    {
      title: 'Search emails',
      description:
        'Search the mailbox with Gmail search syntax. Returns id, threadId, from, to, subject, date, snippet and labels for each match, newest first.',
      inputSchema: searchEmailsInput,
      outputSchema: searchEmailsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ query, max_results }) =>
      runTool('search_emails', async () => {
        const client = await gmail();
        const list = await withRetry('messages.list', () =>
          client.users.messages.list({ userId: 'me', q: query, maxResults: max_results }),
        );
        const ids = (list.data.messages ?? []).flatMap((m) => (m.id ? [m.id] : []));
        // One message failing to load (for example, deleted since the list call)
        // should not hide the others, so failures are counted instead of thrown.
        const settled = await Promise.allSettled(
          ids.map(async (id) => {
            const res = await withRetry('messages.get', () =>
              client.users.messages.get({
                userId: 'me',
                id,
                format: 'metadata',
                metadataHeaders: ['From', 'To', 'Subject', 'Date'],
              }),
            );
            return res.data;
          }),
        );
        const summaries = settled.flatMap((r) => (r.status === 'fulfilled' ? [summarizeMessage(r.value)] : []));
        const failure = settled.find((r) => r.status === 'rejected');
        if (failure && summaries.length === 0) throw failure.reason;

        const skipped = ids.length - summaries.length;
        return {
          text: formatSummaries(summaries, query, skipped),
          structured: {
            query,
            messages: summaries.map(({ labelIds, ...s }) => ({ ...s, labels: labelIds })),
            skipped,
          },
        };
      }),
  );

  server.registerTool(
    'get_email',
    {
      title: 'Read an email',
      description:
        'Read one email: headers including Reply-To, sender authentication (SPF, DKIM, DMARC with domains), ' +
        'the body as text, and attachment names and sizes. Plain text is preferred; the HTML version (with link ' +
        'targets kept) is used or added when the plain part is a stub or says something different. "Note:" lines ' +
        'flag an unauthenticated From domain, hidden HTML text and similar warnings. Attachment contents are never returned.',
      inputSchema: getEmailInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ message_id }) =>
      runTool('get_email', async () => {
        const client = await gmail();
        const res = await withRetry('messages.get', () =>
          client.users.messages.get({ userId: 'me', id: message_id, format: 'full' }),
        );
        return formatEmail(parseMessage(res.data));
      }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Read a thread',
      description:
        'Read every message in a thread, oldest first, each in the same format as get_email. ' +
        'Very long threads are shortened from the oldest message; get_email reads any message in full.',
      inputSchema: getThreadInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ thread_id }) =>
      runTool('get_thread', async () => {
        const client = await gmail();
        const res = await withRetry('threads.get', () =>
          client.users.threads.get({ userId: 'me', id: thread_id, format: 'full' }),
        );
        const emails = fitThreadBudget(sortOldestFirst(res.data.messages ?? []).map(parseMessage));
        return formatThread(thread_id, emails);
      }),
  );

  server.registerTool(
    'create_draft_reply',
    {
      title: 'Create a draft reply',
      description:
        'Save a plain-text reply to an email as a Gmail draft, in the same thread, addressed to the original sender ' +
        '(its Reply-To if set). Nothing is sent: a person reviews and sends the draft from Gmail.',
      inputSchema: createDraftReplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ message_id, body }) =>
      runTool('create_draft_reply', async () => {
        const client = await gmail();
        // The user's own address tells buildReply whether the original was sent by them.
        const [original, profile] = await Promise.all([
          withRetry('messages.get', () =>
            client.users.messages.get({
              userId: 'me',
              id: message_id,
              format: 'metadata',
              metadataHeaders: REPLY_HEADERS,
            }),
          ),
          withRetry('getProfile', () => client.users.getProfile({ userId: 'me' })),
        ]);
        const reply = buildReply(
          originalFromMessage(original.data),
          body,
          profile.data.emailAddress ?? undefined,
        );

        // A 5xx or a timeout may come after Gmail already saved the draft, so
        // only rate limits (rejected before Gmail acted) are retried here.
        const draft = await withRetry(
          'drafts.create',
          () =>
            client.users.drafts.create({
              userId: 'me',
              requestBody: { message: { raw: reply.raw, threadId: reply.threadId } },
            }),
          { retryServerErrors: false },
        );

        return [
          'Draft reply created. It has not been sent.',
          `Draft ID: ${draft.data.id ?? '(unknown)'}`,
          `Thread ID: ${draft.data.message?.threadId ?? reply.threadId}`,
          `To: ${reply.to}`,
          `Subject: ${reply.subject}`,
          'Review and send it from Gmail Drafts.',
        ].join('\n');
      }),
  );

  return server;
}

/**
 * Runs a tool body and turns any failure into a tool error result
 * (`isError: true`) the model can read, instead of a protocol error or a crash.
 * A body may return plain text, or text plus structured content for tools with
 * an output schema. Each call is logged to stderr with its outcome, duration
 * and, on failure, the error message the model sees; never queries or content.
 */
export async function runTool(
  name: string,
  body: () => Promise<string | { text: string; structured: Record<string, unknown> }>,
) {
  const started = Date.now();
  try {
    const result = await body();
    log('info', `${name} ok in ${Date.now() - started} ms`);
    if (typeof result === 'string') return { content: [{ type: 'text' as const, text: result }] };
    return { content: [{ type: 'text' as const, text: result.text }], structuredContent: result.structured };
  } catch (err) {
    const text = err instanceof ReplyError ? err.message : (asAuthError(err)?.message ?? describeGmailError(err));
    log('error', `${name} failed in ${Date.now() - started} ms: ${text}`);
    return { content: [{ type: 'text' as const, text }], isError: true };
  }
}
