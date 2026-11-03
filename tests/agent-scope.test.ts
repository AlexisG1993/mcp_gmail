/**
 * The triage agent's scope rules, tested without a model: whatever tool calls
 * a model asks for, only the email's own thread is readable and at most one
 * draft, replying to that email, is saved.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_TOOL_CALLS, type ScopeLog, scopedTools } from '../examples/lib/agent.js';

const email = { id: 'm-1', threadId: 't-1', from: 'a@example.com', subject: 'Hi' };

function setup(saveDrafts = true) {
  const callTool = vi.fn((_req: { name: string; arguments?: Record<string, unknown> }) =>
    Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  const log: ScopeLog = { calls: [], refused: [], drafts: [] };
  const run = scopedTools({ callTool } as never, email, saveDrafts, log);
  return { run, log, callTool };
}

describe('agent scope', () => {
  it("reads only the email's own thread", async () => {
    const { run, callTool } = setup();
    expect(await run('get_thread', { thread_id: 't-1' })).toBe('ok');
    expect(await run('get_thread', { thread_id: 't-other' })).toMatch(/^Error: only this email's thread/);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('offers no search or other tools, whatever the model asks for', async () => {
    const { run, callTool, log } = setup();
    expect(await run('search_emails', { query: 'bank details' })).toBe('Error: tool search_emails is not available.');
    expect(await run('get_email', { message_id: 'm-secret' })).toBe('Error: tool get_email is not available.');
    expect(callTool).not.toHaveBeenCalled();
    expect(log.refused).toHaveLength(2);
  });

  it('saves at most one draft, and only as a reply to this email', async () => {
    const { run, callTool, log } = setup();
    expect(await run('create_draft_reply', { message_id: 'm-secret', body: 'x' })).toMatch(/^Error: drafts may only reply to message m-1/);
    expect(await run('create_draft_reply', { message_id: 'm-1', body: 'first' })).toBe('ok');
    expect(await run('create_draft_reply', { message_id: 'm-1', body: 'second' })).toBe(
      'Error: a draft has already been saved for this email.',
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(log.drafts).toEqual(['first']);
  });

  it('saves nothing in a dry run', async () => {
    const { run, callTool } = setup(false);
    expect(await run('create_draft_reply', { message_id: 'm-1', body: 'x' })).toBe('Error: drafts are not saved in this run.');
    expect(callTool).not.toHaveBeenCalled();
  });

  it(`stops after ${MAX_TOOL_CALLS} calls`, async () => {
    const { run, callTool } = setup();
    for (let i = 0; i < MAX_TOOL_CALLS; i++) await run('get_thread', { thread_id: 't-1' });
    expect(await run('get_thread', { thread_id: 't-1' })).toMatch(/call limit/);
    expect(callTool).toHaveBeenCalledTimes(MAX_TOOL_CALLS);
  });
});
