# Security model

## Scopes

The server requests exactly two OAuth scopes:

| Scope | Used for |
|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | Searching and reading messages and threads |
| `https://www.googleapis.com/auth/gmail.compose` | Creating drafts |

Gmail has no scope that allows creating drafts without also allowing sending. Google describes `gmail.compose` as "Manage drafts and send emails": it can create, change and delete *drafts*, and send mail. It cannot delete or modify received messages, change labels or change settings; those need `gmail.modify` or full access, which the server never requests.

Access is therefore limited in two layers:

1. **The narrowest scopes Gmail offers for this feature set.**
2. **No send tool.** The only write operation in the code is `users.drafts.create`, and a person reviews and sends each draft from Gmail. The server never deletes or edits drafts.

The second layer is a property of this code, not of the token. Anyone or anything that can read `token.json` could send mail as the user, including another AI agent with file access to the project folder. Treat the token like a password. On a machine where other agents work, keep it outside their reach with `GMAIL_TOKEN_PATH`. The token stays in the project folder by default so that setup is a single step.

Access can be revoked at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Controls

| Risk | Control |
|---|---|
| The agent sends mail in the user's name | No send tool. Replies are saved as drafts for a person to review and send. |
| The agent deletes or alters mail | No `gmail.modify` or full-access scope, and no delete, label or archive tools |
| Prompt injection through email content | Email is untrusted input to the model, and no prompt can fully prevent injection. See [Prompt injection](#prompt-injection) for what an injected model could do and what limits it. |
| Deceptive email | `get_email` shows the Reply-To, SPF/DKIM/DMARC verdicts with their domains, and real link targets. It marks hidden HTML text in place, and shows both versions when the plain text and HTML differ. See [tools.md](tools.md#get_email). |
| Hostile message content | Each body part is cut to 500,000 characters before parsing, and all patterns run in linear time. Tests check that crafted bodies convert in well under a second. |
| A stalled connection | Every Gmail request has a 30-second deadline |
| Header injection through a crafted original | CR/LF is stripped from every header value copied from the original message |
| Malicious attachments | Attachment content is never downloaded; only name, type and size are returned |
| Token leakage | `credentials.json`, `token.json`, its temporary files and `.env` are git-ignored. The token is written atomically, with mode `0600` on POSIX systems. Raw Google client errors, which include the `Authorization` header, are never logged or returned. |
| Sensitive data in logs | Logs contain the tool name, outcome and duration, plus the error message shown to the model when a call fails. Never queries, message content or tokens. |
| Third-party data exposure | Local stdio process. The mailbox owner creates the OAuth client in their own Google Cloud project, and no intermediary service holds tokens. |

## Prompt injection

An email can contain text written to steer the model that reads it. With only this server's tools, an injected model cannot send, delete or change mail. It can still read other mail and put it into a draft reply to the attacker. The draft is one click from being sent, and a person reviewing a long draft might not notice. If the client also has other tools, such as web access, data could leave without any draft.

What limits this:

- **Drafts only go to the sender.** `create_draft_reply` takes no recipient. The reply goes to the original's Reply-To or From, which is shown to the model before it drafts.
- **A person sends every draft.** Nothing leaves the mailbox without someone reviewing it in Gmail.
- **Deception is made visible.** Hidden text is marked as hidden, link targets are shown, and diverging plain and HTML versions are both shown, so a model or person can see what is really in a message.
- **Scope the agent, not just the prompt.** The [triage agent](evaluation.md#triage-agent) gives the model only `get_thread` and `create_draft_reply` for one email, enforced in code. It is limited to that email's thread and message id, gets one draft at most, and cannot search the mailbox, so an injected instruction has no other mail to collect. It also classifies the whole thread, so an injection in an earlier message cannot hide behind a harmless follow-up.
- **Measure it.** The [evaluation](evaluation.md) includes injection attempts, some hidden in invisible HTML or quoted text. A separate agent safety eval plants a secret in the mailbox and checks what reaches saved drafts. The examples also escape the prompt's `<email>` delimiter.

These are mitigations, not guarantees. No classifier or prompt catches every attempt.
