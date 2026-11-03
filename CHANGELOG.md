# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

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
