# gmail-mcp-server

A small Model Context Protocol (MCP) server, written in TypeScript, that gives an AI agent least-privilege access to one Gmail inbox. The agent can search mail, read messages and threads as clean plain text, and save draft replies in the correct thread. It cannot send, delete, label or archive mail, or change settings. The server runs locally as a stdio subprocess of the MCP client. It uses OAuth credentials that the mailbox owner creates and keeps, and it has no backend, database or third-party service in between.

## Tools

| Tool | What it does | Read-only |
|---|---|---|
| `search_emails` | Runs a Gmail search query (default `in:inbox`, 1 to 25 results, default 10). Returns id, threadId, from, to, subject, date, snippet and labels per message. | Yes |
| `get_email` | Reads one message: From, To, Cc, Subject, Date and Message-ID headers, a plain-text body, and attachment names, types and sizes. Attachment content is never downloaded. | Yes |
| `get_thread` | Reads every message in a thread, oldest first, in the same format as `get_email`. | Yes |
| `create_draft_reply` | Saves a plain-text reply as a draft in the original thread, addressed to the original sender. It never sends. | No (creates drafts only) |

Every input is validated with zod before any Gmail call. Each tool declares MCP annotations: `readOnlyHint: true` on the three read tools, and `readOnlyHint: false, destructiveHint: false, idempotentHint: false` on `create_draft_reply`.

Body handling: the parser walks the full MIME tree, including nested `multipart/*`, and decodes base64url and the declared charset (for example ISO-8859-1). It prefers `text/plain` and falls back to `text/html` with a light tag strip. Bodies over 20,000 characters are truncated, with a note in the output saying so.

## Security model

**Scopes.** The server requests exactly two OAuth scopes:

- `https://www.googleapis.com/auth/gmail.readonly` to search and read.
- `https://www.googleapis.com/auth/gmail.compose` to create drafts.

Gmail has no scope that allows creating drafts without also allowing sending: `gmail.compose` permits both. Least privilege is therefore enforced in two layers:

1. The narrowest scopes Gmail offers for this feature set. No `gmail.modify`, no full `mail.google.com`, so the token cannot delete mail, change labels or change settings.
2. No send tool is exposed. The only write operation in the code is `users.drafts.create`, and a person reviews and sends each draft from Gmail.

The second layer is a property of this code, not of the token. Anyone who obtains `token.json` could send mail as the user, so treat it like a password.

**No send, delete or settings tools.** That is deliberate and should stay that way. Drafts are reversible and visible; sent mail is not.

**Untrusted content.** Email bodies and headers are written by strangers and should be treated as untrusted input to the model. A malicious email could try to steer the agent through prompt injection. With this tool set, the worst outcome is an unwanted draft, never a sent or deleted message. The draft builder also strips CR/LF from every header value it copies from the original message. A crafted subject such as `Hi\r\nBcc: attacker@example.com` therefore cannot inject headers into the reply.

**Secrets never in the repository.** `credentials.json`, `token.json` and `.env` are git-ignored.

- The token file is written atomically (temp file, then rename) with mode `0600` on POSIX systems.
- Raw errors from the Google client are never logged or returned, because they include the request's `Authorization` header.
- Logs contain the tool name, outcome and duration only, never queries, addresses or message content.

**Client-owned credentials.** The mailbox owner creates the OAuth client in their own Google Cloud project and signs in on their own machine. Tokens never leave that machine. No intermediary service holds them, and access is revoked at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Setup

Requirements: Node.js 22.12 or later, and a Google account.

**1. Google Cloud (one time, about 5 minutes)**

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one).
2. Enable the Gmail API: APIs & Services, Library, "Gmail API", Enable.
3. Configure the OAuth consent screen (Google Auth Platform):
   - User type: External.
   - Publishing status: Testing.
   - Add the Gmail address you will use under Test users.
4. Create credentials: Clients, Create client, application type **Desktop app**.
5. Download the client JSON and save it as `credentials.json` in the project root.

While the project is in Testing status, Google expires refresh tokens after 7 days. When that happens the tools return a message asking you to run `npm run auth` again. Removing that limit requires publishing the app. Both scopes are classed as restricted by Google, so a public app needs Google's verification, which can include a third-party security assessment. For a single internal mailbox, Testing status or a Google Workspace internal app is the practical option.

**2. Install, sign in, build**

```bash
npm install
npm run auth     # builds, opens the browser, saves token.json
npm run build
```

`npm run auth` uses the OAuth loopback flow with PKCE and a `state` check. It verifies that both scopes were granted, then makes one read-only call to confirm access.

**Configuration**

| Variable | Default | Purpose |
|---|---|---|
| `GMAIL_CREDENTIALS_PATH` | `<project>/credentials.json` | OAuth client file downloaded from Google Cloud |
| `GMAIL_TOKEN_PATH` | `<project>/token.json` | Saved token, written by `npm run auth` and refreshed automatically |

Relative paths are resolved against the project root, not the working directory, because MCP clients start servers from arbitrary directories.

## Connect to Claude

Use the absolute path to `dist/index.js`. On Windows, forward slashes work (`C:/Users/you/gmail-mcp-server/dist/index.js`).

**Claude Desktop.** Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/`
- Windows: `%APPDATA%\Claude\`

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-mcp-server/dist/index.js"]
    }
  }
}
```

Add an `"env"` object with `GMAIL_CREDENTIALS_PATH` and `GMAIL_TOKEN_PATH` only if the files are not in the project root. Restart Claude Desktop afterwards.

**Claude Code**

```bash
claude mcp add --transport stdio gmail -- node /absolute/path/to/gmail-mcp-server/dist/index.js
```

To keep the files elsewhere, add `--env GMAIL_TOKEN_PATH=/secure/path/token.json` (and likewise for credentials) before the server name.

## Triage demo

`examples/triage-demo.ts` shows the server used by an agent pipeline instead of a chat client.

1. It starts the server over stdio with the official MCP client.
2. It reads the 10 most recent inbox emails through `search_emails` and `get_email`.
3. It asks Claude (`claude-opus-5-5`) to classify each one, using structured JSON output validated against a zod schema:
   - type: `customer`, `vendor`, `admin` or `other`
   - priority: `high`, `normal` or `low`
4. It prints a table.

```bash
export ANTHROPIC_API_KEY=...   # PowerShell: $env:ANTHROPIC_API_KEY = "..."
npm run demo
```

The demo calls only read tools. It passes the server only the Gmail path variables, not the API key. It also tells the model to treat email content as untrusted data, never as instructions.

## Design decisions

**stdio transport.** The server is a child process of the MCP client on the user's machine. It opens no network port, so there is no listener to authenticate or expose. The OAuth token stays on the same machine as the user. stdout carries only the MCP protocol: all logging goes to stderr, and `console.log` is redirected to stderr so a dependency cannot corrupt the stream.

**Plain-text output.** Tools return labelled plain text, not raw Gmail JSON. Models read it reliably, it costs far fewer tokens than the API's nested MIME structure, and every tool presents emails in the same shape. Decoding, charset handling, HTML stripping and truncation happen once, in tested code, instead of being left to the model.

**Drafts instead of sending.** Sending is irreversible and acts in the user's name. A draft keeps a person in the loop at the one step where a mistake is costly, while still doing the bulk of the work. Replies go to the original's `Reply-To` if present, otherwise to `From`. If the original was the user's own sent message, the reply goes to its recipients instead. Each reply sets `threadId`, `In-Reply-To` and the full `References` chain, so it threads correctly in Gmail and in other clients.

**Failure handling.**

- Gmail errors become tool results with `isError: true` and a specific message, never a crash. Examples: not found, rate limited, Gmail API not enabled, sign-in expired.
- 429s, 403 rate-limit errors and 5xx responses are retried with exponential backoff and jitter, at most 3 attempts. `Retry-After` is honoured.
- The Google client library's own retry is switched off, so this is the only retry policy. Left on, a single failing call can make 12 HTTP requests.
- Creating a draft is not retried on 5xx, because Gmail may already have saved it and a retry would create a duplicate.
- An expired or revoked sign-in is detected, and the cached client is dropped. Running `npm run auth` then takes effect without restarting the server.

**Dependencies.**

- `@modelcontextprotocol/server` (MCP TypeScript SDK v2), `googleapis`, `google-auth-library` and `zod`.
- No HTML parsing library, no framework, no database.

## From demo to production

This server lets an agent work an inbox on request. A production triage system that processes every incoming email unattended needs more:

- **Push instead of polling.** Call `users.watch` to have Gmail publish mailbox changes to a Cloud Pub/Sub topic, and process them with a subscriber.
- **historyId checkpoints.** Each notification carries a `historyId`. Persist the last processed one, and fetch changes since then with `users.history.list`, so nothing is missed across restarts. If the stored id is too old (Gmail returns 404), fall back to a full sync.
- **Idempotent ticket ledger.** Pub/Sub delivers at least once. Record each Gmail message id in a ledger before acting on it, so a redelivered or replayed notification never creates a second ticket or draft.
- **Dead-letter queue.** Messages that keep failing (parse errors, model errors, downstream outages) go to a DLQ after a bounded number of attempts. Someone inspects them and replays them, and they never block the stream.
- **Daily reconciliation sweep.** A scheduled job lists recent inbox messages and compares them with the ledger, catching anything a dropped notification or outage missed.
- **Watch renewal.** A watch expires after 7 days. Renew it on a schedule; Google recommends daily, which leaves a wide safety margin.
- **Deployment.** Run as a service with secrets in a secret manager. For a Google Workspace domain, use a service account with domain-wide delegation instead of a personal OAuth token. Add metrics and alerting on queue depth, error rate and watch expiry.

## Tests

```bash
npm test            # vitest, no network access
npm run typecheck   # strict TypeScript, source and tests
```

The tests use small JSON fixtures shaped like real Gmail API responses, in `tests/fixtures/`.

- **MIME parsing.** Plain-only, HTML-only, `multipart/alternative`, nested multipart with attachments, attached `.eml` files, non-UTF-8 charsets, base64url edge cases (padding, URL-safe alphabet, multi-byte characters) and truncation at the 20,000-character boundary.
- **Draft building.** Recipient selection, `Re:` handling, `In-Reply-To` and `References`, `threadId`, header-injection attempts, RFC 2047 encoding of non-ASCII subjects and names, line-length limits, and base64url output.
- **Reliability.** Error classification and messages, auth-failure detection, and retry behaviour: what is retried, the attempt cap, backoff ranges, and the `Retry-After` cap.
- **Input validation.** Defaults, bounds and rejection cases for every tool's schema. A test also asserts that nothing is ever written to stdout.

## License

MIT. See [LICENSE](LICENSE).
