import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root, derived from this file's location (src/ or dist/ -> one level up).
// MCP hosts such as Claude Desktop launch the server from an arbitrary working
// directory, so defaults must not depend on process.cwd().
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The only scopes this server ever requests.
// gmail.readonly: search and read messages and threads.
// gmail.compose:  create drafts. It also permits sending; this server exposes no send tool.
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
] as const;

export interface Config {
  credentialsPath: string;
  tokenPath: string;
}

// Relative paths are resolved against the project root, not the working directory,
// so `npm run auth` and an MCP host always agree on where the files live.
function resolvePath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() ? value.trim() : fallback;
  return path.resolve(PROJECT_ROOT, raw);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    credentialsPath: resolvePath(env.GMAIL_CREDENTIALS_PATH, 'credentials.json'),
    tokenPath: resolvePath(env.GMAIL_TOKEN_PATH, 'token.json'),
  };
}
