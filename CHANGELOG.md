# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-03

Hardening after two external reviews, a measured triage classifier, and a scoped triage agent.

### Security

- **Hostile message content can no longer stall the server.** HTML and plain-text conversion used patterns with quadratic worst cases: a crafted 40,000-character body took about 5 s. Every pattern is now linear, each part is capped at 500,000 characters before conversion, and tests convert 2.5 MB of adversarial markup within their limit.
- **Sender authentication is shown, and cannot be faked.** `get_email` shows SPF/DKIM/DMARC verdicts with the domain each applies to. They come only from Gmail's own `Authentication-Results` header, with comments removed. A note is added when the From domain fails DMARC.
- **Deception is visible.**
  - `get_email` shows Reply-To, which drafts are addressed to.
  - HTML conversion keeps link targets, including entity-encoded and protocol-relative ones.
  - Hidden text (the `hidden` attribute, `display:none`, zero size or opacity, same-colour text) is marked in place as `[hidden text: ...]`.
  - Both versions are shown when the plain text and HTML differ.
- **A 30-second deadline on every Gmail request.** Timeouts are retried on reads only, never when creating a draft.
- **Accurate security documentation.** It describes what an injected model could still do, and that `gmail.compose` can delete drafts, though not messages.
- Temporary token files and the agent ledger are git-ignored.

### Added

- **Structured output for `search_emails`,** with a declared output schema.
- **Classifier evaluation** (`npm run eval`).
  - An 84-email development set, including hard legitimate mail that carries the usual warning signs.
  - A 30-email held-out test set (`--set test`).
  - The reports include a prompt fingerprint, confusion matrices and a table of warning signs by label.
  - Held-out result on `gemini-3.1-flash-lite`: 93.3% type accuracy, 9/10 suspicious caught, and 0/20 false alarms.
- **Triage agent** (`npm run agent`). The model reads the thread and writes a reply through the MCP tools. Its tools, thread and message id are restricted in code.
- **Agent safety eval** (`npm run eval:agent`). The real agent and server run against a fake mailbox with a planted secret, with and without triage.
- **A `suspicious` category** in the triage schema.
- **Gemini as a second provider** for the examples (`TRIAGE_PROVIDER=gemini`). Claude remains the default. The model is configurable with `TRIAGE_MODEL`, and the examples read an optional `.env` file.
- **Tests.**
  - End-to-end tool tests through a real MCP client.
  - Tests of the agent's scope rules.
  - Tests of authentication parsing, hidden text, links and timeouts.
  - 165 tests in total, up from 112.
- **Documentation** in `docs/`: tool reference, security model, evaluation, design and troubleshooting. There is also a README screenshot of real demo output.

### Changed

- **The HTML version of a message is shown when the plain-text part is only a stub of it.**
- **`get_thread` shares a 60,000-character budget across the thread,** keeping the newest messages whole first.
- **`search_emails` skips a match that fails to load** instead of failing the whole search.
- **The triage agent defaults to a dry run.**
  - `--save-drafts` saves at most one draft per email, enforced in code, and keeps a ledger so reruns never draft twice.
  - It classifies the whole thread, not just the newest message.
- **The demo prints each reason in full,** and one failing email no longer aborts a run.
- **The default triage model is a small one** (`claude-haiku-5-5`, or `gemini-3.5-flash-lite` for Gemini), instead of a hard-coded large one.
- **The README is shorter,** with the detail moved into `docs/`.

## [0.1.0] - 2026-11-02

First release.

### Added

- **MCP server over stdio** with four tools: `search_emails`, `get_email`, `get_thread` and `create_draft_reply`.
- **Least-privilege OAuth.** Only the `gmail.readonly` and `gmail.compose` scopes are requested, and no send, delete or settings tool is exposed.
- **`npm run auth`.** A one-time sign-in using the OAuth loopback flow with PKCE and a `state` check, with scope verification and automatic token refresh and persistence.
- **MIME parsing.**
  - Walks nested multipart messages and decodes base64url and the declared charset.
  - Prefers plain text, with an HTML fallback.
  - Reports attachment metadata without downloading content.
  - Truncates bodies at 20,000 characters.
- **RFC 2822 reply builder.**
  - Picks recipients from `Reply-To` or `From`.
  - Adds the `Re:` prefix and sets `In-Reply-To`, `References` and `threadId`.
  - Encodes non-ASCII headers with RFC 2047.
  - Strips CR/LF from copied header values to block header injection.
- **Reliability.**
  - Retries 429, 403 rate-limit and 5xx responses with exponential backoff and jitter, honouring `Retry-After`.
  - Turns errors into readable tool results, and detects expired sign-ins.
  - Logs to stderr only.
- **Tests.** A vitest suite with Gmail-shaped fixtures and no network access.
- **Triage demo** (`npm run demo`). Classifies recent inbox email with the Claude API using structured output.
- **CI.** GitHub Actions runs type-checks, tests and a build on Node 22 and 24.

[Unreleased]: https://github.com/AlexisG1993/mcp_gmail/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/AlexisG1993/mcp_gmail/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AlexisG1993/mcp_gmail/releases/tag/v0.1.0
