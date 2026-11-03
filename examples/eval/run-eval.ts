/**
 * Triage evaluation: `npm run eval`.
 *
 * Classifies the labeled emails in dataset.ts with the configured provider and
 * model, then reports accuracy, a confusion matrix, how many phishing and
 * prompt-injection emails were caught, tokens and latency. Each email is
 * rendered by the server's own parser and formatter, so the model sees exactly
 * what get_email would return. No Gmail account is needed.
 *
 * `--set dev` (default) uses the development set, which the prompt may be
 * tuned on. `--set test` uses the held-out set, which must not be.
 *
 * Results are printed and saved to examples/eval/results/<model>.<set>.md,
 * with a fingerprint of the system prompt so a score can be tied to a prompt.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { gmail_v1 } from 'googleapis';
import { formatEmail, parseMessage } from '../../src/gmail/parse.js';
import { type Classification, PRIORITIES, SYSTEM_PROMPT, TYPES, makeClassifier, mapLimit, PROJECT_ROOT, selectModel } from '../lib/triage.js';
import { DATASET, type EvalEmail } from './dataset.js';
import { TESTSET } from './testset.js';

const SETS: Record<string, EvalEmail[]> = { dev: DATASET, test: TESTSET };
const SET_NAME = process.argv.includes('--set') ? (process.argv[process.argv.indexOf('--set') + 1] ?? '') : 'dev';
const PROMPT_ID = createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 8);

const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY) || 3;

// USD per million tokens, for the cost column. Models not listed show no cost.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

const AUTH_RESULTS = {
  pass: (domain: string) => `mx.google.com; dkim=pass header.i=@${domain}; spf=pass smtp.mailfrom=${domain}; dmarc=pass header.from=${domain}`,
  softfail: (domain: string) => `mx.google.com; dkim=none; spf=softfail smtp.mailfrom=${domain}; dmarc=fail header.from=${domain}`,
  fail: (domain: string) => `mx.google.com; dkim=fail header.i=@${domain}; spf=fail smtp.mailfrom=${domain}; dmarc=fail header.from=${domain}`,
};

/** Builds the Gmail API message the server would receive for a dataset email. */
function toGmailMessage(e: EvalEmail): gmail_v1.Schema$Message {
  const domain = /@([^>\s]+)/.exec(e.from)?.[1] ?? 'unknown.example';
  const headers: Record<string, string> = {
    From: e.from,
    To: 'Sam Harbor <sam@harborpine.example>',
    Subject: e.subject,
    Date: 'Tue, 3 Nov 2026 09:00:00 +0000',
    'Message-ID': `<${e.id}@${domain}>`,
    'Authentication-Results': AUTH_RESULTS[e.auth ?? 'pass'](domain),
  };
  if (e.replyTo) headers['Reply-To'] = e.replyTo;
  const part = (mimeType: string, text: string) => ({ mimeType, body: { data: Buffer.from(text).toString('base64url') } });
  return {
    id: e.id,
    threadId: `t-${e.id}`,
    payload: {
      mimeType: 'multipart/alternative',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      parts: [...(e.plain !== undefined ? [part('text/plain', e.plain)] : []), ...(e.html !== undefined ? [part('text/html', e.html)] : [])],
    },
  };
}

interface Outcome {
  email: EvalEmail;
  got: Classification | undefined;
  note: string | undefined;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

async function main(): Promise<void> {
  const emails = SETS[SET_NAME];
  if (!emails) throw new Error(`Unknown --set "${SET_NAME}". Use dev or test.`);
  const { provider, model } = selectModel();
  const classify = makeClassifier(provider, model);
  console.log(`Evaluating ${model} (${provider}) on the ${SET_NAME} set: ${emails.length} emails, prompt ${PROMPT_ID}...\n`);

  const outcomes = await mapLimit(emails, CONCURRENCY, async (email): Promise<Outcome> => {
    const rendered = formatEmail(parseMessage(toGmailMessage(email)));
    const r = await classify(rendered);
    process.stderr.write('.');
    return {
      email,
      got: typeof r.result === 'string' ? undefined : r.result,
      note: typeof r.result === 'string' ? r.result : undefined,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      ms: r.ms,
    };
  });
  process.stderr.write('\n\n');

  const report = buildReport(provider, model, outcomes);
  console.log(report);
  const dir = path.join(PROJECT_ROOT, 'examples', 'eval', 'results');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${model}.${SET_NAME}.md`);
  writeFileSync(file, report);
  console.log(`Saved to ${path.relative(PROJECT_ROOT, file)}`);
}

const SIGNALS: [string, (e: EvalEmail) => boolean][] = [
  ['Failed or soft-failed authentication', (e) => (e.auth ?? 'pass') !== 'pass'],
  ['HTML body', (e) => e.html !== undefined],
  ['Contains a link', (e) => /https?:\/\//.test(`${e.plain ?? ''} ${e.html ?? ''}`)],
  ['Reply-To set', (e) => e.replyTo !== undefined],
  ['Hidden HTML text', (e) => /display:\s*none|color:\s*#fff/i.test(e.html ?? '')],
  ['Mentions an AI, assistant or bot', (e) => /\b(AI|assistant|ChatGPT|bot)\b/i.test(`${e.plain ?? ''} ${e.html ?? ''}`)],
];

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
}

function buildReport(provider: string, model: string, outcomes: Outcome[]): string {
  const n = outcomes.length;
  const typeOk = outcomes.filter((o) => o.got?.type === o.email.expected.type).length;
  const prioOk = outcomes.filter((o) => o.got?.priority === o.email.expected.priority).length;
  const bothOk = outcomes.filter((o) => o.got?.type === o.email.expected.type && o.got?.priority === o.email.expected.priority).length;
  const failed = outcomes.filter((o) => !o.got).length;

  const tagged = (tag: string) => outcomes.filter((o) => o.email.tags?.includes(tag as never));
  const caught = (list: Outcome[]) => list.filter((o) => o.got?.type === 'suspicious').length;
  const suspicious = outcomes.filter((o) => o.email.expected.type === 'suspicious');
  const falseAlarms = outcomes.filter((o) => o.email.expected.type !== 'suspicious' && o.got?.type === 'suspicious');
  const injections = tagged('injection');

  const inputTokens = outcomes.reduce((s, o) => s + o.inputTokens, 0);
  const outputTokens = outcomes.reduce((s, o) => s + o.outputTokens, 0);
  const latencies = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(n * 0.5)] ?? 0;
  const p95 = latencies[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
  const price = PRICES[model];
  const cost = price ? (inputTokens * price.input + outputTokens * price.output) / 1e6 : undefined;

  const lines = [
    `# Triage eval: ${model}, ${SET_NAME} set`,
    '',
    `Provider \`${provider}\`, ${n} labeled emails (examples/eval/${SET_NAME === 'test' ? 'testset' : 'dataset'}.ts), ` +
      `system prompt \`${PROMPT_ID}\`, run ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '| Metric | Result |',
    '|---|---|',
    `| Type accuracy | ${pct(typeOk, n)} |`,
    `| Priority accuracy | ${pct(prioOk, n)} |`,
    `| Type and priority both right | ${pct(bothOk, n)} |`,
    `| Suspicious emails caught (recall) | ${pct(caught(suspicious), suspicious.length)} |`,
    `| Phishing caught | ${pct(caught(tagged('phishing')), tagged('phishing').length)} |`,
    `| Prompt injections caught | ${pct(caught(injections), injections.length)} |`,
    `| Legitimate email flagged suspicious | ${pct(falseAlarms.length, n - suspicious.length)} |`,
    `| Failed or declined calls | ${failed} |`,
    `| Tokens (input / output, total) | ${inputTokens.toLocaleString('en-US')} / ${outputTokens.toLocaleString('en-US')} |`,
    `| Latency per email (p50 / p95) | ${(p50 / 1000).toFixed(2)} s / ${(p95 / 1000).toFixed(2)} s |`,
    ...(cost !== undefined ? [`| Cost for the run | $${cost.toFixed(4)} ($${((cost / n) * 1000).toFixed(2)} per 1,000 emails) |`] : []),
    '',
    '## Warning signs by true label',
    '',
    'How often each signal appears on legitimate and on suspicious email in this set. A signal that appeared only on suspicious email would let a model score well by keying on it.',
    '',
    '| Signal | Legitimate | Suspicious |',
    '|---|---:|---:|',
    ...SIGNALS.map(([label, test]) => {
      const legit = outcomes.filter((o) => o.email.expected.type !== 'suspicious' && test(o.email)).length;
      const susp = outcomes.filter((o) => o.email.expected.type === 'suspicious' && test(o.email)).length;
      return `| ${label} | ${legit} of ${n - suspicious.length} | ${susp} of ${suspicious.length} |`;
    }),
    '',
    '## Type confusion matrix',
    '',
    'Rows are the expected type, columns what the model answered.',
    '',
    `| expected \\ got | ${TYPES.join(' | ')} | failed |`,
    `|---|${TYPES.map(() => '---:').join('|')}|---:|`,
    ...TYPES.map((expected) => {
      const row = outcomes.filter((o) => o.email.expected.type === expected);
      const cells = TYPES.map((got) => row.filter((o) => o.got?.type === got).length);
      return `| **${expected}** | ${cells.join(' | ')} | ${row.filter((o) => !o.got).length} |`;
    }),
    '',
    '## Priority confusion matrix',
    '',
    `| expected \\ got | ${PRIORITIES.join(' | ')} | failed |`,
    `|---|${PRIORITIES.map(() => '---:').join('|')}|---:|`,
    ...PRIORITIES.map((expected) => {
      const row = outcomes.filter((o) => o.email.expected.priority === expected);
      const cells = PRIORITIES.map((got) => row.filter((o) => o.got?.priority === got).length);
      return `| **${expected}** | ${cells.join(' | ')} | ${row.filter((o) => !o.got).length} |`;
    }),
    '',
    '## Misses',
    '',
  ];
  const misses = outcomes.filter((o) => o.got?.type !== o.email.expected.type || o.got?.priority !== o.email.expected.priority);
  if (misses.length === 0) lines.push('None.');
  else {
    lines.push('| id | subject | expected | got | reason |', '|---|---|---|---|---|');
    for (const o of misses) {
      const got = o.got ? `${o.got.type} / ${o.got.priority}` : '-';
      const reason = (o.got?.reason ?? o.note ?? '').replace(/\|/g, '\\|');
      lines.push(`| ${o.email.id} | ${o.email.subject.replace(/\|/g, '\\|')} | ${o.email.expected.type} / ${o.email.expected.priority} | ${got} | ${reason} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

main().catch((err: unknown) => {
  console.error(`Eval failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
