import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, asAuthError, withRetry } from '../src/gmail/client.js';
import { describeGmailError, errorInfo } from '../src/gmail/errors.js';

/** An error shaped like the ones gaxios throws for a Gmail API response. */
function gmailError(status: number, reason?: string, message = 'Gmail says no', headers: Record<string, string> = {}) {
  const data = { error: { code: status, message, errors: reason ? [{ reason, message }] : [] } };
  return Object.assign(new Error(message), { status, response: { status, data, headers: new Headers(headers) } });
}

const noSleep = () => Promise.resolve();

beforeEach(() => {
  // Retry warnings and other logs go to stderr; keep test output quiet.
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

describe('errorInfo', () => {
  it('reads status, reason, message and Retry-After from a gaxios-style error', () => {
    expect(errorInfo(gmailError(429, 'rateLimitExceeded', 'Slow down', { 'Retry-After': '3' }))).toEqual({
      status: 429,
      reason: 'rateLimitExceeded',
      message: 'Slow down',
      code: undefined,
      retryAfterSeconds: 3,
    });
  });

  it('copes with plain errors and non-errors', () => {
    expect(errorInfo(new Error('boom'))).toMatchObject({ status: undefined, message: 'boom' });
    expect(errorInfo('just a string')).toMatchObject({ status: undefined, message: 'just a string' });
  });
});

describe('describeGmailError', () => {
  it.each([
    [gmailError(404, 'notFound'), 'Gmail found no message or thread with that id'],
    [gmailError(400, 'invalidArgument', 'Invalid query'), 'Gmail rejected the request: Invalid query'],
    [gmailError(429), 'Gmail rate limit reached'],
    [gmailError(403, 'userRateLimitExceeded'), 'Gmail rate limit reached'],
    [gmailError(503, 'backendError'), 'Gmail is temporarily unavailable (HTTP 503)'],
    [gmailError(403, 'accessNotConfigured'), 'The Gmail API is not enabled'],
    [gmailError(409, undefined, 'Conflict'), 'Gmail request failed (HTTP 409): Conflict'],
    [Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'Could not reach Gmail (ENOTFOUND)'],
    [new Error('bug'), 'Unexpected error: bug'],
  ])('maps %#', (err, expected) => {
    expect(describeGmailError(err)).toContain(expected);
  });
});

describe('asAuthError', () => {
  it('recognizes an expired or revoked refresh token', () => {
    const err = Object.assign(new Error('invalid_grant'), {
      response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
    });
    expect(asAuthError(err)?.message).toMatch(/expired or was revoked.*npm run auth/);
  });

  it('recognizes a rejected access token and a missing scope', () => {
    expect(asAuthError(gmailError(401))).toBeInstanceOf(AuthError);
    expect(asAuthError(gmailError(403, 'insufficientPermissions'))?.message).toMatch(/permissions.*npm run auth/);
  });

  it('passes an existing AuthError through and ignores everything else', () => {
    const existing = new AuthError('No token');
    expect(asAuthError(existing)).toBe(existing);
    expect(asAuthError(gmailError(404, 'notFound'))).toBeUndefined();
    expect(asAuthError(gmailError(403, 'rateLimitExceeded'))).toBeUndefined();
  });
});

describe('withRetry', () => {
  it('retries a 5xx and returns the eventual success', async () => {
    const request = vi.fn().mockRejectedValueOnce(gmailError(503)).mockResolvedValueOnce('ok');
    await expect(withRetry('test', request, { sleep: noSleep })).resolves.toBe('ok');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retries 429 and 403 rate limits', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(gmailError(429))
      .mockRejectedValueOnce(gmailError(403, 'rateLimitExceeded'))
      .mockResolvedValueOnce('ok');
    await expect(withRetry('test', request, { sleep: noSleep })).resolves.toBe('ok');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 attempts and rethrows the last error', async () => {
    const last = gmailError(500, 'backendError', 'third failure');
    const request = vi.fn().mockRejectedValueOnce(gmailError(500)).mockRejectedValueOnce(gmailError(502)).mockRejectedValueOnce(last);
    await expect(withRetry('test', request, { sleep: noSleep })).rejects.toBe(last);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['404', gmailError(404, 'notFound')],
    ['400', gmailError(400)],
    ['401', gmailError(401)],
    ['403 without a rate-limit reason', gmailError(403, 'insufficientPermissions')],
    ['a network error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
  ])('does not retry %s', async (_label, err) => {
    const request = vi.fn().mockRejectedValue(err);
    await expect(withRetry('test', request, { sleep: noSleep })).rejects.toBe(err);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('skips 5xx retries when retryServerErrors is false, but still retries rate limits', async () => {
    const serverError = vi.fn().mockRejectedValue(gmailError(503));
    await expect(withRetry('test', serverError, { sleep: noSleep, retryServerErrors: false })).rejects.toThrow();
    expect(serverError).toHaveBeenCalledTimes(1);

    const rateLimited = vi.fn().mockRejectedValueOnce(gmailError(429)).mockResolvedValueOnce('ok');
    await expect(withRetry('test', rateLimited, { sleep: noSleep, retryServerErrors: false })).resolves.toBe('ok');
  });

  it('backs off exponentially with jitter', async () => {
    const delays: number[] = [];
    const request = vi.fn().mockRejectedValue(gmailError(503));
    await expect(
      withRetry('test', request, { baseDelayMs: 1000, sleep: async (ms) => void delays.push(ms) }),
    ).rejects.toThrow();
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(1000);
    expect(delays[1]).toBeLessThanOrEqual(2000);
  });

  it('honors Retry-After, capped at 8 seconds', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => void delays.push(ms);
    const request = vi
      .fn()
      .mockRejectedValueOnce(gmailError(429, undefined, 'wait', { 'Retry-After': '3' }))
      .mockRejectedValueOnce(gmailError(429, undefined, 'wait', { 'Retry-After': '120' }))
      .mockResolvedValueOnce('ok');
    await withRetry('test', request, { sleep });
    expect(delays).toEqual([3000, 8000]);
  });
});

describe('timeouts', () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { code: 'TimeoutError' });

  it('retries a timed-out read', async () => {
    const request = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue('ok');
    await expect(withRetry('read', request, { sleep: noSleep })).resolves.toBe('ok');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timed-out write, which may already have succeeded', async () => {
    const request = vi.fn().mockRejectedValue(timeout());
    await expect(withRetry('drafts.create', request, { sleep: noSleep, retryServerErrors: false })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('explains a timeout', () => {
    expect(describeGmailError(timeout())).toBe('Gmail did not respond in time. Try again shortly.');
  });
});
