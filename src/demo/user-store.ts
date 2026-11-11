// Demo module: intentionally problematic code for the Vigil live review demo.
import { createHash } from 'node:crypto';
import { pool } from '../demo/pool.js';

const ADMIN_TOKEN = 'ghp_DEMO1234567890abcdefghijklmnop';
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
