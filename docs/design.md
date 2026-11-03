# Design decisions

## stdio transport

The server is a child process of the MCP client on the user's machine. It opens no network port, so there is no listener to authenticate or expose, and the OAuth token stays on the same machine as the user.

stdout carries only the MCP protocol. All logging goes to stderr, and `console.log` is redirected to stderr so a dependency cannot corrupt the stream.

## Plain-text output

Tools return labelled plain text, not raw Gmail JSON:
- models read it reliably;
- it costs far fewer tokens than the API's nested MIME structure;
- every tool presents emails in the same shape.

Decoding, charset handling, HTML conversion, hidden-text marking and truncation happen once, in tested code, instead of being left to the model. `search_emails` also returns structured content, because its main consumer in an agent pipeline is code that needs the ids.

## Drafts instead of sending

Sending is irreversible and acts in the user's name. A draft keeps a person in the loop at the one step where a mistake is costly, while still doing the bulk of the work.

## Failure handling

- **Errors become readable results.** Gmail errors become tool results with `isError: true` and a specific message, never a crash. Examples: not found, rate limited, Gmail API not enabled, sign-in expired, timed out.
- **One retry policy.**
  - What is retried: 429s, 403 rate-limit errors, 5xx responses and timeouts, at most 3 attempts.
  - How: exponential backoff with jitter. `Retry-After` is honoured, capped at 8 seconds.
  - The Google client library's own retry is switched off, so this is the only policy. Left on, a single failing call can make 12 HTTP requests.
- **A deadline on every request.** Each Gmail request has 30 seconds, so a stalled connection cannot hang a tool call.
- **No duplicate drafts.** Creating a draft is not retried after a 5xx or a timeout, because Gmail may already have saved it, and a retry would create a duplicate.
- **Expired sign-ins recover without a restart.** An expired or revoked sign-in is detected, and the cached client is dropped. Running `npm run auth` then takes effect without restarting the server.

## Minimal dependencies

- Runtime: `@modelcontextprotocol/server` (MCP TypeScript SDK v2), `googleapis`, `google-auth-library` and `zod`.
- No HTML parsing library, no framework, no database. The HTML conversion is deliberately small and linear-time. A full HTML parser would handle more layouts, but it is a larger attack surface and harder to bound.

## Limitations

- **One mailbox per server instance.** Each instance runs with one token; multiple mailboxes need multiple configured instances.
- **Plain-text drafts only.** Drafts have no HTML formatting and no attachments, and replies go to the sender only (no reply-all).
- **No attachment content.** Attachments are reported by name, type and size only, by design.
- **Bounded output.** Bodies are truncated at 20,000 characters, threads at 60,000, and search returns at most 25 results with no pagination.
- **Light HTML conversion.** It suits typical email but is not a renderer, so complex layouts lose some structure. Hidden text is detected only through inline styles and the `hidden` attribute, not stylesheets, and a hidden element is assumed to end at the next closing tag of the same name.
- **Injection defenses are mitigations.** They reduce what an injected model can reach and make deception visible, but no classifier or prompt catches every attempt.
- **Testing-mode tokens.** Unpublished Google Cloud projects expire refresh tokens after 7 days.

## From demo to production

This server lets an agent work an inbox on request. A production triage system that processes every incoming email unattended needs more:

| Capability | Purpose |
|---|---|
| **Push notifications** | Call `users.watch` to have Gmail publish mailbox changes to a Cloud Pub/Sub topic, processed by a subscriber, instead of polling. |
| **historyId checkpoints** | Each notification carries a `historyId`. Persist the last processed one and fetch changes since then with `users.history.list`, so nothing is missed across restarts. If the stored id is too old (Gmail returns 404), fall back to a full sync. |
| **Idempotent ticket ledger** | Pub/Sub delivers at least once. Record each Gmail message id before acting on it, so a redelivered notification never creates a second ticket or draft. The triage agent's local ledger file is the single-machine version of this. |
| **Dead-letter queue** | Messages that keep failing (parse errors, model errors, downstream outages) move to a DLQ after a bounded number of attempts, for inspection and replay, without blocking the stream. |
| **Daily reconciliation sweep** | A scheduled job compares recent inbox messages with the ledger and catches anything a dropped notification or outage missed. |
| **Watch renewal** | A watch expires after 7 days. Renew it on a schedule; Google recommends daily, which leaves a wide safety margin. |
| **Deployment** | Run as a service with secrets in a secret manager. For a Google Workspace domain, use a service account with domain-wide delegation instead of a personal OAuth token. Add metrics and alerting on queue depth, error rate and watch expiry. |
