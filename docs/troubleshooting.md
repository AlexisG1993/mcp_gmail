# Troubleshooting

| Message or symptom | Cause and fix |
|---|---|
| `OAuth client file not found at ...` | `credentials.json` is missing. Download the Desktop app client from Google Cloud and save it in the project root, or set `GMAIL_CREDENTIALS_PATH`. |
| `... is not a Desktop app OAuth client file` | The client was created as a Web application. Create a **Desktop app** client instead. |
| Google shows "Access blocked" or "has not completed the Google verification process" | Your address is not a test user. Add it under **Google Auth Platform > Audience > Test users**. |
| `Sign-in did not grant all required permissions` | A permission was unticked on the consent screen. Run `npm run auth` again and leave every Gmail permission ticked. |
| `No saved Gmail token found at ...` | Sign-in has not been done for this path. Run `npm run auth`. |
| `The saved Gmail sign-in has expired or was revoked.` | Usually the 7-day Testing-mode expiry. Run `npm run auth`; no restart is needed. |
| `The Gmail API is not enabled for this Google Cloud project.` | Enable the Gmail API under **APIs & Services > Library**. |
| `Gmail rate limit reached, even after retrying.` | Gmail is throttling the account. Wait a minute and retry. |
| `Gmail did not respond in time.` | A request took longer than 30 seconds, even after retrying. Check the network connection and try again. |
| The client shows no Gmail tools | Check that the config path points to `dist/index.js`, that `npm run build` has been run, and restart the client. Server logs go to stderr, which Claude Desktop writes to its MCP log files. |
| The examples report `API error 429` from Gemini | The Gemini free tier allows about 15 requests per minute and has a daily cap. The examples wait as long as Google asks, but a daily cap only resets the next day. Lower `EVAL_CONCURRENCY`, or use a paid key. |
