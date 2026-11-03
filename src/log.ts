export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Writes one log line to stderr. stdout carries the MCP protocol, so nothing
 * else may ever be written there. Callers pass plain messages, never raw error
 * objects (those can contain OAuth tokens) or email content.
 */
export function log(level: LogLevel, message: string): void {
  process.stderr.write(`${new Date().toISOString()} [gmail-mcp] ${level.toUpperCase()} ${message}\n`);
}
