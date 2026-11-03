import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { log } from './log.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol; a single stray line there breaks the client
// connection. Our code logs through log(), but a dependency calling
// console.log would still corrupt the stream, so those calls go to stderr too.
console.log = console.info = console.debug = console.error;

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

try {
  await createServer().connect(new StdioServerTransport());
  log('info', 'Server running on stdio.');
} catch (err) {
  log('error', `Failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
