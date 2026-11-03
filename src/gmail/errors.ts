/**
 * Classifies errors thrown by googleapis (gaxios) and turns them into short,
 * human-readable messages. Pure functions, so they are easy to test.
 *
 * Never log or return the raw error object: gaxios errors carry the request
 * configuration, including the `Authorization: Bearer ...` header.
 */

// Gmail reports per-user and per-project rate limits as 403 with these reasons,
// not only as 429.
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

// Low-level network failures worth naming in the message.
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH']);

export interface ErrorInfo {
  /** HTTP status, if the request got a response. */
  status: number | undefined;
  /** Google's machine-readable reason, e.g. `notFound` or `rateLimitExceeded`. */
  reason: string | undefined;
  /** Google's human-readable message, or the error's own message. */
  message: string;
  /** Node network error code, e.g. `ECONNRESET`. */
  code: string | undefined;
  /** Seconds from a `Retry-After` header, if present. */
  retryAfterSeconds: number | undefined;
}

export function errorInfo(err: unknown): ErrorInfo {
  const e = isRecord(err) ? err : {};
  const response = isRecord(e.response) ? e.response : {};
  const data = isRecord(response.data) ? response.data : {};
  // Gmail's JSON error body: { error: { code, message, status, errors: [{ reason, message }] } }
  const body = isRecord(data.error) ? data.error : {};
  const first = Array.isArray(body.errors) && isRecord(body.errors[0]) ? body.errors[0] : {};

  const statusValue = typeof e.status === 'number' ? e.status : response.status;
  const retryAfter = Number(headerValue(response.headers, 'retry-after'));

  return {
    status: typeof statusValue === 'number' ? statusValue : undefined,
    reason: typeof first.reason === 'string' ? first.reason : undefined,
    message:
      typeof body.message === 'string' ? body.message : err instanceof Error ? err.message : String(err),
    code: typeof e.code === 'string' ? e.code : undefined,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
  };
}

export function isRateLimit(info: ErrorInfo): boolean {
  return info.status === 429 || (info.status === 403 && info.reason !== undefined && RATE_LIMIT_REASONS.has(info.reason));
}

export function isServerError(info: ErrorInfo): boolean {
  return info.status !== undefined && info.status >= 500 && info.status <= 599;
}

/** No response within GMAIL_TIMEOUT_MS; gaxios reports this as code `TimeoutError`. */
export function isTimeout(info: ErrorInfo): boolean {
  return info.code === 'TimeoutError';
}

/**
 * A readable message for any Gmail failure that is not an auth problem.
 * Auth failures (expired sign-in, missing scope) are recognized first by
 * `asAuthError` in client.ts.
 */
export function describeGmailError(err: unknown): string {
  const info = errorInfo(err);
  const { status, reason, message } = info;

  if (isRateLimit(info)) return 'Gmail rate limit reached, even after retrying. Wait a minute and try again.';
  if (isServerError(info)) return `Gmail is temporarily unavailable (HTTP ${status}), even after retrying. Try again shortly.`;
  if (isTimeout(info)) return 'Gmail did not respond in time. Try again shortly.';
  if (status === 404) return 'Gmail found no message or thread with that id. It may have been deleted, or the id is wrong.';
  if (status === 403 && (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(message))) {
    return 'The Gmail API is not enabled for this Google Cloud project. Enable it in Google Cloud Console, then try again.';
  }
  if (status === 400) return `Gmail rejected the request: ${message}`;
  if (status !== undefined) return `Gmail request failed (HTTP ${status}): ${message}`;
  if (info.code !== undefined && NETWORK_CODES.has(info.code)) {
    return `Could not reach Gmail (${info.code}). Check the network connection and try again.`;
  }
  return `Unexpected error: ${message}`;
}

function headerValue(headers: unknown, name: string): unknown {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return isRecord(headers) ? headers[name] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
