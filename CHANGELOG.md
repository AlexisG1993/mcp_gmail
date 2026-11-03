# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **Hostile message content can no longer stall the server.** HTML and plain-text conversion used patterns with quadratic worst cases: a crafted 40,000-character body took about 5 s. Every pattern is now linear, each part is capped at 500,000 characters before conversion, and a 1 MB hostile body converts in under 25 ms. Tests cover it.
- **Deception is visible to the model.** `get_email` now shows Reply-To, which drafts are addressed to, and Gmail's SPF/DKIM/DMARC verdicts. HTML conversion keeps link targets, and a note flags elements styled as hidden.
- **Honest prompt-injection documentation.** The README now describes what an injected model could still do, such as copying mail into a draft reply to the attacker, and what limits it.
- Temporary token files are git-ignored.

### Added

- **Structured output for `search_emails`,** with a declared output schema, so agent code does not parse display text.
- **Triage agent** (`npm run agent`). The model reads threads and saves draft replies through the MCP tools, with its tools, thread and message id restricted in code, and a `--dry-run` mode.
- **Labeled evaluation** (`npm run eval`). 60 synthetic emails, including phishing and prompt injections, rendered through the server's own parser. It reports accuracy, confusion matrices, injection catch rate, tokens and latency.
- **A `suspicious` category** in the triage schema for phishing, spoofing, spam and injection attempts.
- **End-to-end tool tests** through a real MCP client and an in-memory transport.
- **Gemini provider for the triage demo.** `TRIAGE_PROVIDER=gemini` with `GEMINI_API_KEY` runs the same classification on Gemini with the same output schema. Claude remains the default.
- **README screenshot** of real `npm run demo` output, with addresses and names blurred.

### Changed

- **The HTML version of a message is shown when the plain-text part is only a stub of it,** such as a "view in browser" line.
- **`get_thread` shares a 60,000-character budget across the thread,** keeping the newest messages whole first.
- **`search_emails` skips a match that fails to load** instead of failing the whole search.
- **The demo prints each reason in full,** and one failing email no longer aborts the run.

- **Configurable triage model.** The demo reads its model from `TRIAGE_MODEL`, defaulting to `claude-haiku-5-5` instead of a hard-coded `claude-opus-5-5`. Refusal fallbacks are requested only for models that support them.
- **`.env` support.** The demo loads an optional git-ignored `.env` file from the project root.

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

[Unreleased]: https://github.com/AlexisG1993/mcp_gmail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AlexisG1993/mcp_gmail/releases/tag/v0.1.0
