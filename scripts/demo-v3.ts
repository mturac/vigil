// One-off: create the v3 demo PR files (same intentionally-flawed module).
import { readFileSync } from 'node:fs';

const USER_STORE = `// Demo module: intentionally problematic code for the Vigil live review demo.
import { createHash } from 'node:crypto';
import { pool } from '../demo/pool.js';

const ADMIN_TOKEN = 'tok_admin_9f3a21';
const DB_HOST = '10.0.4.12';

export async function findUser(email: string): Promise<unknown> {
  // NOTE: string-built SQL — demo of sql-string-concat
  const sql = "SELECT * FROM users WHERE email = '" + email + "' LIMIT 1";
  const res = await pool.query(sql);
  return res.rows[0];
}

export function hashPassword(password: string): string {
  return createHash('md5').update(password).digest('hex');
}

export function makeSessionToken(): string {
  return Math.random().toString(36).slice(2);
}

export function runPlugin(code: string): unknown {
  return eval(code);
}

export async function warmCache(): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch {}
}

export function fetchHealth(): Promise<Response> {
  return fetch('http://internal-status.local/health');
}
`;

const POOL = `// Demo stub pool so the demo file parses standalone.
export const pool = {
  query: async (_sql: string) => ({ rows: [] as unknown[] }),
};
`;

const GH = process.env.GITHUB_TOKEN ?? readFileSync('/home/z/my-project/.secrets/gh.token', 'utf8').trim();

async function put(path: string, content: string, message: string): Promise<void> {
  const url = `https://api.github.com/repos/mturac/vigil/contents/${encodeURIComponent(path)}`;
  let sha: string | undefined;
  const cur = await fetch(url + '?ref=demo/vigil-review-v3', { headers: { Authorization: `token ${GH}` } });
  if (cur.ok) sha = (await cur.json() as { sha?: string }).sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `token ${GH}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(content, 'utf8').toString('base64'), branch: 'demo/vigil-review-v3', ...(sha ? { sha } : {}) }),
  });
  console.log(path, '->', res.status);
}

async function main(): Promise<void> {
  await put('src/demo/pool.ts', POOL, 'demo: add stub pool (v3 demo)');
  await new Promise((r) => setTimeout(r, 1500));
  await put('src/demo/user-store.ts', USER_STORE, 'demo: add intentionally flawed user-store (v3 live review demo)');
  const pr = await fetch('https://api.github.com/repos/mturac/vigil/pulls', {
    method: 'POST',
    headers: { Authorization: `token ${GH}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Add user-store module (live review demo v3 — anchored findings)',
      head: 'demo/vigil-review-v3',
      base: 'main',
      body: 'Live demo of Vigil autonomous code review, **v3**.\n\nSame intentionally flawed module as v2, but now reviewed by the fixed engine:\n- LLM findings are **anchored** to corroborating added lines (no more hallucinated line numbers)\n- LLM + heuristic **corroboration** instead of duplicates (`heuristic+llm`)\n- **idempotent** re-reviews of the same head SHA\n\nBugs planted: hardcoded token (L5), internal host (L6), SQL string concat (L10), md5 password hashing (L16), Math.random session tokens (L20), eval of untrusted code (L24), swallowed catch (L30), plain-HTTP fetch (L34).',
    }),
  });
  const data = await pr.json() as { number?: number; html_url?: string; message?: string };
  console.log('PR:', pr.status, data.number ?? data.message, data.html_url ?? '');
}

void main();
