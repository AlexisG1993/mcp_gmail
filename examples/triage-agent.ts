/**
 * Triage agent: `npm run agent`.
 *
 * Triages recent inbox mail and, for each customer or vendor email that needs
 * a reply, lets the model read the thread and write a reply through this
 * server's MCP tools. See examples/lib/agent.ts for the limits enforced in code.
 *
 * By default nothing is saved: replies are printed. `-- --save-drafts` saves
 * them as Gmail drafts, at most one per email, and records handled message ids
 * in .triage-agent-ledger.json so a rerun never drafts the same email twice.
 * Nothing is ever sent.
 */
import path from 'node:path';
import { Ledger, runTriageAgent } from './lib/agent.js';
import { PROJECT_ROOT, connectServer, makeClassifier, selectModel } from './lib/triage.js';

const SAVE_DRAFTS = process.argv.includes('--save-drafts');
const LEDGER_FILE = path.join(PROJECT_ROOT, '.triage-agent-ledger.json');

async function main(): Promise<void> {
  const { provider, model } = selectModel();
  const mcp = await connectServer('triage-agent');
  console.log(`Triage agent with ${model} (${provider}), ${SAVE_DRAFTS ? 'saving drafts' : 'dry run: nothing is saved'}...\n`);

  try {
    const outcomes = await runTriageAgent(mcp, {
      provider,
      model,
      classify: makeClassifier(provider, model),
      saveDrafts: SAVE_DRAFTS,
      ledger: new Ledger(SAVE_DRAFTS ? LEDGER_FILE : undefined),
      count: 10,
    });

    for (const o of outcomes) {
      const label = typeof o.triage === 'string' ? o.triage || '-' : `${o.triage.type}/${o.triage.priority}`;
      console.log(`=== ${o.email.subject}\n  triage: ${label}`);
      if (o.skipped) {
        console.log(`  skipped: ${o.skipped}\n`);
        continue;
      }
      for (const call of o.log.calls) console.log(`  tool: ${call}${o.log.refused.includes(call) ? '  [refused]' : ''}`);
      console.log(`  ${(o.answer ?? '').replace(/\n/g, '\n  ')}\n`);
    }
    if (SAVE_DRAFTS) console.log('Review the drafts in Gmail Drafts. Nothing was sent.');
    else console.log('Dry run: nothing was saved. Add `-- --save-drafts` to save these replies as drafts.');
  } finally {
    await mcp.close();
  }
}

main().catch((err: unknown) => {
  console.error(`Triage agent failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
