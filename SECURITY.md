# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**.

Include a description of the issue, steps to reproduce it, and the affected version or commit. You will get an acknowledgement within a few working days.

## Supported versions

Security fixes are applied to the latest release on the `main` branch.

## Scope

In scope:

- **Wider access than intended.** Any way for a tool call to send, delete or modify mail, or to change settings.
- **Token exposure.** Leakage of `token.json`, `credentials.json` or OAuth tokens through logs, tool output or error messages.
- **Header injection.** Any way to inject headers or recipients into a draft reply through crafted message content.
- **Input validation bypasses** that reach the Gmail API with unvalidated input.

Out of scope:

- **Gmail's own behaviour,** including the fact that the `gmail.compose` scope permits sending at the API level. See the README's security model.
- **A compromised local machine or OAuth client.** Anyone who can read the token file can act as the user.

## Handling secrets

Never include real `credentials.json` or `token.json` contents, access tokens, or email content in a report. Redact them, or reproduce the issue with a test account.
