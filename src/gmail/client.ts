import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { GMAIL_SCOPES, loadConfig, type Config } from '../config.js';
import { log } from '../log.js';
import { errorInfo, isRateLimit, isServerError } from './errors.js';

const RUN_AUTH = 'Run `npm run auth` in the project folder to sign in.';

/** Missing, unreadable or insufficient credentials. The message is safe to show to the user. */
export class AuthError extends Error {
  override readonly name = 'AuthError';
}

export interface ClientSecrets {
  clientId: string;
  clientSecret: string;
}

/**
 * Reads the Desktop app OAuth client downloaded from Google Cloud.
 * Error messages never include file contents.
 */
export async function readClientSecrets(path: string): Promise<ClientSecrets> {
  const parsed = await readJson(
    path,
    `OAuth client file not found at ${path}. Download a Desktop app OAuth client from Google Cloud Console and save it there, or set GMAIL_CREDENTIALS_PATH.`,
  );
  const installed = isRecord(parsed) ? parsed.installed : undefined;
  if (!isRecord(installed)) {
    const hint =
      isRecord(parsed) && 'web' in parsed
        ? ' It looks like a Web application client; create a Desktop app client instead.'
        : '';
    throw new AuthError(`${path} is not a Desktop app OAuth client file.${hint}`);
  }
  const { client_id: clientId, client_secret: clientSecret } = installed;
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    throw new AuthError(`${path} is missing client_id or client_secret.`);
  }
  return { clientId, clientSecret };
}

export function createOAuthClient(secrets: ClientSecrets, redirectUri?: string): OAuth2Client {
  return new OAuth2Client({
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
    ...(redirectUri ? { redirectUri } : {}),
  });
}

/** Returns the required scopes that a token's space-separated `scope` string does not grant. */
export function missingScopes(granted: string | null | undefined): string[] {
  const grantedSet = new Set((granted ?? '').split(' '));
  return GMAIL_SCOPES.filter((scope) => !grantedSet.has(scope));
}

export async function readToken(path: string): Promise<Credentials> {
  const parsed = await readJson(path, `No saved Gmail token found at ${path}. ${RUN_AUTH}`);
  if (!isRecord(parsed) || typeof parsed.refresh_token !== 'string') {
    throw new AuthError(`The saved token at ${path} has no refresh token. ${RUN_AUTH}`);
  }
  if (typeof parsed.scope === 'string') {
    const missing = missingScopes(parsed.scope);
    if (missing.length > 0) {
      throw new AuthError(`The saved token is missing required permissions (${missing.join(', ')}). ${RUN_AUTH}`);
    }
  }
  return parsed as Credentials;
}

/**
 * Writes the token atomically (temp file, then rename) so a crash mid-write
 * never leaves a half-written token.json. Mode 0600 limits it to the current
 * user on POSIX systems; Windows ignores the mode.
 */
export async function writeToken(path: string, token: Credentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(token, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Builds an OAuth client from the saved token and keeps token.json current.
 * google-auth-library refreshes the access token on its own when it expires and
 * emits a `tokens` event; Google usually omits the refresh token from refresh
 * responses, so new fields are merged into the saved token rather than replacing it.
 */
async function createAuthorizedClient(config: Config): Promise<OAuth2Client> {
  const secrets = await readClientSecrets(config.credentialsPath);
  let token = await readToken(config.tokenPath);

  const auth = createOAuthClient(secrets);
  auth.setCredentials(token);

  // Saves are chained so two refreshes close together cannot interleave their writes.
  let saving = Promise.resolve();
  auth.on('tokens', (update: Credentials) => {
    const defined = Object.entries(update).filter(([, value]) => value !== null && value !== undefined);
    token = { ...token, ...Object.fromEntries(defined) };
    const snapshot = token;
    saving = saving
      .then(() => writeToken(config.tokenPath, snapshot))
      .catch((err: unknown) => {
        log('error', `Could not save the refreshed token: ${errorMessage(err)}`);
      });
  });

  return auth;
}

let cachedClient: Promise<gmail_v1.Gmail> | undefined;

/**
 * Returns the authenticated Gmail client, created on first use.
 * Loading lazily lets the MCP server start without a token and report a clear
 * tool error instead. A failed load is not cached, so running `npm run auth`
 * fixes things without restarting the server.
 */
export function getGmail(config: Config = loadConfig()): Promise<gmail_v1.Gmail> {
  cachedClient ??= createAuthorizedClient(config)
    // googleapis retries 429/5xx on its own by default. That is switched off so
    // withRetry below is the single, explicit retry policy.
    .then((auth) => google.gmail({ version: 'v1', auth, retry: false }))
    .catch((err: unknown) => {
      cachedClient = undefined;
      throw err;
    });
  return cachedClient;
}

/**
 * Recognizes failures that `npm run auth` fixes: Google rejected the refresh
 * token (`invalid_grant`: expired or revoked), Gmail rejected the access token
 * (HTTP 401), or the token lacks a required scope (403 insufficientPermissions).
 * For those it returns a user-facing AuthError and drops the cached client, so
 * the next call re-reads token.json. Returns undefined for every other error.
 */
export function asAuthError(err: unknown): AuthError | undefined {
  if (err instanceof AuthError) return err;
  const info = errorInfo(err);
  // The token endpoint answers { error: 'invalid_grant' }; gaxios uses that string as the message.
  const response = isRecord(err) && isRecord(err.response) ? err.response : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const invalidGrant = data?.error === 'invalid_grant' || info.message === 'invalid_grant';

  let message: string;
  if (invalidGrant || info.status === 401) {
    message =
      'The saved Gmail sign-in has expired or was revoked. ' +
      '(Google ends sign-ins after 7 days while a Cloud project is in Testing mode.)';
  } else if (info.status === 403 && info.reason === 'insufficientPermissions') {
    message = 'The saved Gmail sign-in does not grant the permissions this server needs.';
  } else {
    return undefined;
  }

  cachedClient = undefined;
  return new AuthError(`${message} ${RUN_AUTH}`);
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before the first retry; doubles each time. */
  baseDelayMs?: number;
  /**
   * Retry 5xx responses. Safe for reads. Turn off for calls that create
   * something, where a 5xx may have succeeded on Gmail's side and a retry
   * would create a duplicate. Rate limits are always retried: those requests
   * were rejected before Gmail acted on them.
   */
  retryServerErrors?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_DELAY_MS = 8_000;

/**
 * Runs a Gmail request, retrying rate limits (429, or 403 with a rate-limit
 * reason) and 5xx responses with exponential backoff: about 0.5 s, then 1 s,
 * with random jitter so parallel requests do not retry in lockstep. A
 * `Retry-After` header from Gmail is honored, capped at 8 s.
 */
export async function withRetry<T>(label: string, request: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 500, retryServerErrors = true, sleep = defaultSleep } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (err) {
      const info = errorInfo(err);
      const retryable = isRateLimit(info) || (retryServerErrors && isServerError(info));
      if (!retryable || attempt >= attempts) throw err;

      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const jittered = backoff / 2 + (Math.random() * backoff) / 2;
      const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(jittered, (info.retryAfterSeconds ?? 0) * 1000));
      const reason = info.reason ? ` ${info.reason}` : '';
      log('warn', `${label}: HTTP ${info.status}${reason}; retry ${attempt} of ${attempts - 1} in ${Math.round(delay)} ms`);
      await sleep(delay);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readJson(path: string, notFoundMessage: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') throw new AuthError(notFoundMessage);
    throw new AuthError(`Could not read ${path}: ${errorMessage(err)}`);
  }
  try {
    // Strip a UTF-8 byte-order mark, which some Windows editors add and JSON.parse rejects.
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    throw new AuthError(`${path} is not valid JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
