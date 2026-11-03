/**
 * Triage demo: `npm run demo`.
 *
 * Connects to this MCP server as a client (the same way Claude Desktop does),
 * reads the 10 most recent inbox emails through its tools, asks a model to
 * classify each one with structured JSON output, and prints a table.
 *
 * Requires a completed `npm run auth` and an API key in the environment or a git-ignored
 * .env file. TRIAGE_PROVIDER picks the vendor: `anthropic` (default, ANTHROPIC_API_KEY)
 * or `gemini` (GEMINI_API_KEY). TRIAGE_MODEL overrides the provider's default model.
 * Nothing is written to the mailbox: only the read tools are called.
 */
import { type ClassifyResult, callTool, connectServer, fit, listInbox, makeClassifier, mapLimit, selectModel } from './lib/triage.js';

const EMAIL_COUNT = 10;

interface Row {
  from: string;
  subject: string;
  result: ClassifyResult['result']; // a string is an error or refusal note
}

async function main(): Promise<void> {
  const { provider, model } = selectModel();
  const classify = makeClassifier(provider, model);
  const mcp = await connectServer('triage-demo');

  try {
    const messages = await listInbox(mcp, EMAIL_COUNT);
    if (messages.length === 0) {
      console.log('The inbox is empty.');
      return;
    }

    console.log(`Classifying ${messages.length} email(s) with ${model} (${provider})...\n`);
    const rows = await mapLimit(messages, 4, async (m): Promise<Row> => {
      try {
        const { text } = await callTool(mcp, 'get_email', { message_id: m.id });
        return { from: m.from, subject: m.subject, result: (await classify(text)).result };
      } catch (err) {
        // One unreadable email becomes one row, not a failed run.
        return { from: m.from, subject: m.subject, result: err instanceof Error ? err.message : String(err) };
      }
    });
    printTable(rows);
  } finally {
    await mcp.close();
  }
}

function printTable(rows: Row[]): void {
  const columns = [
    { title: '#', width: 2 },
    { title: 'From', width: 28 },
    { title: 'Subject', width: 50 },
    { title: 'Type', width: 10 },
    { title: 'Priority', width: 8 },
  ];
  const line = (cells: string[]) => cells.map((c, i) => fit(c, columns[i]?.width ?? 10)).join('  ').trimEnd();

  console.log(line(columns.map((c) => c.title)));
  console.log(line(columns.map((c) => '-'.repeat(c.width))));
  rows.forEach((row, i) => {
    const r = row.result;
    const [type, priority, reason] = typeof r === 'string' ? ['-', '-', r] : [r.type, r.priority, r.reason];
    console.log(line([String(i + 1), row.from, row.subject, type, priority]));
    console.log(`    ↳ ${reason}`);
  });
}

main().catch((err: unknown) => {
  console.error(`Triage demo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
