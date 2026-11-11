// Regression tests for the anchoring & settlement layer.
// The cases below reproduce a REAL incident: on PR mturac/vigil#2 the same
// LLM finding came back on different wrong lines across three runs
// (secret on 7 / 5 / 8; sql-injection on 12 / 10 / 11) and duplicate
// LLM+heuristic findings inflated a 39-line PR to 15 findings / risk 100.
import { describe, expect, it } from 'vitest';
import { anchorLine, settleFindings } from '../src/analysis/anchor.js';
import type { DiffFile, HeuristicFinding, LlmFinding } from '../src/analysis/types.js';

// The actual file content of PR #2 (src/demo/user-store.ts), added-file diff.
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
}`;

function makeFile(path: string, content: string): DiffFile {
  const lines = content.split('\n');
  return {
    path,
    previousPath: undefined,
    changeType: 'added',
    additions: lines.length,
    deletions: 0,
    isBinary: false,
    language: 'ts',
    hunks: [{
      header: `@@ -0,0 +1,${lines.length} @@`,
      oldStart: 0, newStart: 1,
      lines: lines.map((text, i) => ({ type: 'add' as const, newLine: i + 1, text })),
    }],
    addedLines: lines.map((text, i) => ({ line: i + 1, text })),
  };
}

const userStore = makeFile('src/demo/user-store.ts', USER_STORE);

function llm(path: string, line: number, title: string, detail: string, extra?: Partial<LlmFinding>): LlmFinding {
  return { path, line, severity: 'critical', category: 'security', title, detail, suggestion: 'Fix it.', confidence: 90, ...extra };
}

describe('anchorLine', () => {
  it('keeps a correct claimed line as-is', () => {
    const res = anchorLine(llm('src/demo/user-store.ts', 5, 'Hardcoded secret', 'Admin token is hardcoded in source code.'), userStore);
    expect(res).toEqual({ line: 5, reAnchored: false });
  });

  it('re-anchors a hallucinated secret line (claimed 7, real 5)', () => {
    // exact incident: run 1 claimed line 7, run 3 claimed line 8
    const res = anchorLine(llm('src/demo/user-store.ts', 7, 'Hardcoded secret token', 'Admin token is hardcoded in source code, exposing credentials.'), userStore);
    expect(res?.line).toBe(5);
    expect(res?.reAnchored).toBe(true);
    const res8 = anchorLine(llm('src/demo/user-store.ts', 8, 'Hardcoded secret token', 'Admin token is hardcoded in source code, exposing credentials.'), userStore);
    expect(res8?.line).toBe(5);
  });

  it('re-anchors a hallucinated SQL-injection line to the query site (claimed 12/11, real 10-11)', () => {
    // Both hallucination variants settle on the same line: the statement that
    // builds/executes the vulnerable SQL (within 1 line of the concat at 10).
    const res = anchorLine(llm('src/demo/user-store.ts', 12, 'SQL injection', 'SQL query built by string concatenation allows injection attacks.'), userStore);
    expect([10, 11]).toContain(res?.line);
    expect(res?.reAnchored).toBe(true);
    const res11 = anchorLine(llm('src/demo/user-store.ts', 11, 'SQL injection', 'SQL query built by string concatenation allows injection attacks.'), userStore);
    expect([10, 11]).toContain(res11?.line);
    // determinism: both variants land on the SAME line
    expect(res?.line).toBe(res11?.line);
  });

  it('re-anchors md5 / Math.random / eval findings to their real lines', () => {
    expect(anchorLine(llm('src/demo/user-store.ts', 3, 'Weak hash', 'Uses the md5 hashing algorithm which is broken for passwords.'), userStore)?.line).toBe(16);
    expect(anchorLine(llm('src/demo/user-store.ts', 1, 'Insecure randomness', 'Math.random is not cryptographically secure for session tokens.'), userStore)?.line).toBe(20);
    expect(anchorLine(llm('src/demo/user-store.ts', 30, 'Unsafe eval', 'Arbitrary code execution via eval of untrusted input.'), userStore)?.line).toBe(24);
  });

  it('drops a finding that cannot be anchored to any added line', () => {
    const res = anchorLine(llm('src/demo/other.ts', 3, 'Whatever', 'Something something unrelated'), userStore);
    expect(res).toBeNull();
  });

  it('drops a finding whose text matches nothing in the file', () => {
    const res = anchorLine(llm('src/demo/user-store.ts', 99, 'Cache poisoning', 'The redis TTL allows cache poisoning of downstream consumers.'), userStore);
    expect(res).toBeNull();
  });
});

describe('settleFindings', () => {
  const heuristics: HeuristicFinding[] = [
    { ruleId: 'secret-in-code', category: 'security', severity: 'critical', confidence: 95, path: 'src/demo/user-store.ts', line: 5, message: 'Hardcoded secret', suggestion: 'Move to env' },
    { ruleId: 'sql-string-concat', category: 'security', severity: 'critical', confidence: 98, path: 'src/demo/user-store.ts', line: 10, message: 'SQL built by concatenation', suggestion: 'Parameterize' },
    { ruleId: 'weak-hash', category: 'security', severity: 'high', confidence: 90, path: 'src/demo/user-store.ts', line: 16, message: 'md5 used for passwords', suggestion: 'Use argon2' },
  ];

  it('folds a corroborating LLM finding into the heuristic rule instead of duplicating it', () => {
    const llms = [llm('src/demo/user-store.ts', 7, 'Hardcoded secret token', 'Admin token is hardcoded in source code, exposing credentials.')];
    const merged = settleFindings(heuristics, llms, [userStore]);
    expect(merged).toHaveLength(3); // NOT 4 — no duplicate row
    const secret = merged.find((f) => f.ruleId === 'secret-in-code')!;
    expect(secret.source).toBe('heuristic+llm');
    expect(secret.line).toBe(5); // deterministic rule line, not the hallucinated 7
    expect(secret.confidence).toBeGreaterThan(95);
  });

  it('keeps a pure-LLM finding anchored to a real added line', () => {
    const llms = [llm('src/demo/user-store.ts', 30, 'Unsafe eval', 'Arbitrary code execution via eval of untrusted input.', { severity: 'critical' })];
    const merged = settleFindings(heuristics, llms, [userStore]);
    const ev = merged.find((f) => f.source === 'llm');
    expect(ev).toBeDefined();
    expect(ev!.line).toBe(24);
    expect(ev!.snippet).toContain('eval');
  });

  it('drops LLM findings for paths not present in the diff', () => {
    const llms = [llm('src/does/not/exist.ts', 3, 'X', 'Y')];
    expect(settleFindings(heuristics, llms, [userStore])).toHaveLength(3);
  });

  it('escalates severity when the LLM is more alarmed than the rule', () => {
    const heurLow: HeuristicFinding[] = [
      { ruleId: 'http-url', category: 'quality', severity: 'low', confidence: 60, path: 'src/demo/user-store.ts', line: 34, message: 'Plain HTTP URL', suggestion: 'Use https' },
    ];
    const llms = [llm('src/demo/user-store.ts', 34, 'Insecure transport', 'Health endpoint fetched over plain http.', { severity: 'high' })];
    const merged = settleFindings(heurLow, llms, [userStore]);
    expect(merged[0].severity).toBe('high');
    expect(merged[0].source).toBe('heuristic+llm');
  });

  it('returns findings sorted by severity then confidence', () => {
    const llms = [
      llm('src/demo/user-store.ts', 30, 'Unsafe eval', 'eval of untrusted input', { severity: 'critical' }),
      llm('src/demo/user-store.ts', 1, 'Insecure randomness', 'Math.random for session tokens', { severity: 'high' }),
    ];
    const merged = settleFindings(heuristics, llms, [userStore]);
    const sev = merged.map((f) => f.severity);
    expect(sev.indexOf('critical')).toBeLessThan(sev.lastIndexOf('critical'));
    expect(merged[0].severity).toBe('critical');
  });

  it('reproduces the PR #2 incident end-to-end: 3 runs, 3 different hallucinated lines, one stable answer', () => {
    // three observed hallucination variants for the same two findings
    const variants: [number, number][] = [[7, 12], [5, 10], [8, 11]];
    for (const [secretLine, sqlLine] of variants) {
      const llms = [
        llm('src/demo/user-store.ts', secretLine, 'Hardcoded secret token', 'Admin token is hardcoded in source code, exposing credentials.'),
        llm('src/demo/user-store.ts', sqlLine, 'SQL injection', 'SQL query built by string concatenation allows injection attacks.'),
      ];
      const merged = settleFindings(heuristics, llms, [userStore]);
      // always folds into the same deterministic rules, same lines, never duplicates
      expect(merged).toHaveLength(3);
      expect(merged.find((f) => f.ruleId === 'secret-in-code')!.line).toBe(5);
      expect(merged.find((f) => f.ruleId === 'sql-string-concat')!.line).toBe(10);
      expect(merged.find((f) => f.ruleId === 'secret-in-code')!.source).toBe('heuristic+llm');
      expect(merged.find((f) => f.ruleId === 'sql-string-concat')!.source).toBe('heuristic+llm');
    }
  });
});
