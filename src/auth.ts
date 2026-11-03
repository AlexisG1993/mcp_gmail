/**
 * One-time sign-in: `npm run auth`.
 *
 * Runs the OAuth 2.0 loopback flow for a Desktop app client: starts a temporary
 * HTTP server on 127.0.0.1, opens the Google consent page in the browser, receives
 * the authorization code on the redirect, exchanges it (with PKCE) for tokens and
 * saves them to token.json.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { google } from 'googleapis';
import { CodeChallengeMethod } from 'google-auth-library';
import { GMAIL_SCOPES, loadConfig } from './config.js';
import {
  AuthError,
  createOAuthClient,
  errorMessage,
  missingScopes,
  readClientSecrets,
  writeToken,
} from './gmail/client.js';

const TIMEOUT_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = await readClientSecrets(config.credentialsPath);

  // Port 0 lets the OS pick a free port. Google accepts any loopback port for Desktop clients.
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;

  const client = createOAuthClient(secrets, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  if (!codeChallenge) throw new Error('Could not generate a PKCE code challenge.');
  const state = randomBytes(16).toString('hex');

  const authUrl = client.generateAuthUrl({
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // Google only returns a refresh token on a fresh consent
    scope: [...GMAIL_SCOPES],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  console.error('Opening the Google sign-in page in your browser.');
  console.error(`If it does not open, visit this URL:\n\n${authUrl}\n`);
  openBrowser(authUrl);

  const code = await waitForCode(server, redirectUri, state);
  const { tokens } = await client.getToken({ code, codeVerifier });

  if (!tokens.refresh_token) {
    throw new AuthError('Google did not return a refresh token. Run `npm run auth` again.');
  }
  // Google's consent screen lets the user untick individual permissions.
  const missing = missingScopes(tokens.scope);
  if (missing.length > 0) {
    throw new AuthError(
      `Sign-in did not grant all required permissions (${missing.join(', ')}). ` +
        'Run `npm run auth` again and leave every Gmail permission ticked.',
    );
  }

  await writeToken(config.tokenPath, tokens);
  console.error(`Token saved to ${config.tokenPath}.`);

  // End-to-end check: one read-only call proves the token and the Gmail API both work.
  client.setCredentials(tokens);
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.error(`Signed in as ${profile.data.emailAddress ?? 'unknown address'}.`);
    console.error(
      'Note: while your Google Cloud project is in Testing mode, Google ends this sign-in after 7 days. ' +
        'Run `npm run auth` again when that happens.',
    );
  } catch (err) {
    throw new Error(
      `The token was saved, but a test call to Gmail failed: ${errorMessage(err)}\n` +
        'Check that the Gmail API is enabled for this Google Cloud project.',
    );
  }
}

/** Resolves with the authorization code from Google's redirect, then closes the server. */
function waitForCode(server: http.Server, redirectUri: string, expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new AuthError('Timed out waiting for sign-in. Run `npm run auth` again.')), TIMEOUT_MS);

    function finish(result: string | Error): void {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end(); // e.g. the browser's favicon request
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      // The page never echoes query parameters back into the HTML.
      const respond = (message: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
      };

      if (state !== expectedState) {
        respond('Sign-in failed: unexpected state. Return to the terminal.');
        finish(new AuthError('Sign-in response had an unexpected state value. Run `npm run auth` again.'));
      } else if (error) {
        respond('Sign-in was cancelled or denied. Return to the terminal.');
        finish(new AuthError(`Google returned an error: ${error}. Run \`npm run auth\` again.`));
      } else if (!code) {
        respond('Sign-in failed: no authorization code. Return to the terminal.');
        finish(new AuthError('Google did not return an authorization code. Run `npm run auth` again.'));
      } else {
        respond('Signed in. You can close this tab and return to the terminal.');
        finish(code);
      }
    });
  });
}

/** Opens a URL in the default browser without a shell, so the URL is never interpreted as a command. */
function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // No browser available; the URL is already printed.
  });
  child.unref();
}

main().catch((err: unknown) => {
  // Only the message is printed. Errors from the token exchange carry the request
  // configuration, which includes the client secret and authorization code.
  console.error(`\nSign-in failed: ${errorMessage(err)}`);
  process.exitCode = 1;
});
