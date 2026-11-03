import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftReplyInput, getEmailInput, getThreadInput, runTool, searchEmailsInput } from '../src/server.js';

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

describe('search_emails input', () => {
  it('applies defaults', () => {
    expect(searchEmailsInput.parse({})).toEqual({ query: 'in:inbox', max_results: 10 });
  });

  it('trims the query and accepts the bounds of max_results', () => {
    expect(searchEmailsInput.parse({ query: '  from:alice  ', max_results: 1 }).query).toBe('from:alice');
    expect(searchEmailsInput.parse({ max_results: 25 }).max_results).toBe(25);
  });

  it.each([
    ['max_results 0', { max_results: 0 }],
    ['max_results 26', { max_results: 26 }],
    ['fractional max_results', { max_results: 2.5 }],
    ['max_results as a string', { max_results: '10' }],
    ['an empty query', { query: '   ' }],
    ['an overlong query', { query: 'x'.repeat(501) }],
    ['a non-string query', { query: 42 }],
  ])('rejects %s', (_label, input) => {
    expect(searchEmailsInput.safeParse(input).success).toBe(false);
  });
});

describe.each([
  ['get_email', getEmailInput, 'message_id'],
  ['get_thread', getThreadInput, 'thread_id'],
] as const)('%s input', (_tool, schema, field) => {
  it('accepts a Gmail id and trims whitespace', () => {
    expect(schema.parse({ [field]: ' 1a19f03b434f9baf ' })).toEqual({ [field]: '1a19f03b434f9baf' });
  });

  it.each([
    ['a missing id', {}],
    ['an empty id', { [field]: '' }],
    ['a path-like id', { [field]: '../etc/passwd' }],
    ['an id with spaces inside', { [field]: 'abc def' }],
    ['an overlong id', { [field]: 'a'.repeat(65) }],
    ['a numeric id', { [field]: 12345 }],
  ])('rejects %s', (_label, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('create_draft_reply input', () => {
  it('accepts an id and a body, keeping the body exactly as written', () => {
    const body = '  Hi Alice,\n\nThanks!\n';
    expect(createDraftReplyInput.parse({ message_id: '18c2f0a1b2c3d4e5', body })).toEqual({
      message_id: '18c2f0a1b2c3d4e5',
      body,
    });
  });

  it.each([
    ['a missing body', { message_id: 'abc' }],
    ['an empty body', { message_id: 'abc', body: '' }],
    ['a whitespace-only body', { message_id: 'abc', body: ' \n\t ' }],
    ['an overlong body', { message_id: 'abc', body: 'x'.repeat(50_001) }],
    ['a non-string body', { message_id: 'abc', body: 42 }],
    ['a missing id', { body: 'hi' }],
    ['a path-like id', { message_id: '../drafts', body: 'hi' }],
  ])('rejects %s', (_label, input) => {
    expect(createDraftReplyInput.safeParse(input).success).toBe(false);
  });
});

describe('runTool', () => {
  it('returns text content on success', async () => {
    await expect(runTool('t', async () => 'hello')).resolves.toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  it('turns a Gmail error into a readable tool error instead of throwing', async () => {
    const notFound = Object.assign(new Error('Requested entity was not found.'), { status: 404, response: { status: 404 } });
    const result = await runTool('t', () => Promise.reject(notFound));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Gmail found no message or thread with that id');
  });

  it('turns an auth failure into a "run npm run auth" message', async () => {
    const expired = Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    const result = await runTool('t', () => Promise.reject(expired));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('npm run auth');
  });

  it('logs to stderr only, never stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    await runTool('t', async () => 'ok');
    await runTool('t', () => Promise.reject(new Error('boom')));
    expect(stdout).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringMatching(/INFO t ok in \d+ ms/));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringMatching(/ERROR t failed in \d+ ms: Unexpected error: boom/));
  });
});
