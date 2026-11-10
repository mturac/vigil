import { describe, expect, it } from 'vitest';
import { buildDiffFile, type RawFileEntry } from '../src/analysis/diff.js';
import { runHeuristics, HEURISTIC_RULES } from '../src/analysis/heuristics.js';

function file(patch: string, filename = 'src/app.ts', extra: Partial<RawFileEntry> = {}) {
  const lines = patch.split('\n');
  let adds = 0, dels = 0;
  for (const l of lines) { if (l.startsWith('+') && !l.startsWith('+++')) adds++; else if (l.startsWith('-') && !l.startsWith('---')) dels++; }
  return buildDiffFile({ filename, status: 'modified', additions: adds, deletions: dels, patch, ...extra });
}

describe('heuristics engine', () => {
  it('flags known AWS keys with critical severity', () => {
    const f = file(`@@ -1,3 +1,4 @@
 const x = 1;
+const awsKey = "AKIAIOSFODNN7EXAMPLE2";
+const other = 2;
`);
    const findings = runHeuristics([f]);
    const secret = findings.find((x) => x.ruleId === 'secret-in-code');
    expect(secret).toBeDefined();
    expect(secret!.severity).toBe('critical');
    expect(secret!.path).toBe('src/app.ts');
    expect(secret!.line).toBe(2);
  });

  it('does not flag example/dummy generic secrets', () => {
    const f = file(`@@ -1,3 +1,4 @@
+password = "examplepassword"
+api_key: "dummy-key-12345"
`);
    const findings = runHeuristics([f]);
    expect(findings.some((x) => x.ruleId === 'secret-in-code')).toBe(false);
  });

  it('flags generic real-looking secrets at lower confidence', () => {
    const f = file(`@@ -1,3 +1,4 @@
+const config = { token: "a1b2c3d4e5f6g7h8" };
`);
    const findings = runHeuristics([f]);
    const secret = findings.find((x) => x.ruleId === 'secret-in-code');
    expect(secret).toBeDefined();
    expect(secret!.confidence).toBe(55);
  });

  it('flags SQL string concatenation', () => {
    const f = file(`@@ -1,3 +1,4 @@
+const q = "SELECT * FROM users WHERE id = " + userId;
`);
    const findings = runHeuristics([f]);
    const sql = findings.find((x) => x.ruleId === 'sql-string-concat');
    expect(sql).toBeDefined();
    expect(sql!.severity).toBe('high');
    expect(sql!.line).toBe(1);
  });

  it('flags eval and debugger', () => {
    const f = file(`@@ -1,3 +1,5 @@
+eval(userCode);
+debugger;
`);
    const findings = runHeuristics([f]);
    expect(findings.some((x) => x.ruleId === 'eval-usage')).toBe(true);
    expect(findings.some((x) => x.ruleId === 'debugger-statement')).toBe(true);
  });

  it('flags disabled TLS verification as critical', () => {
    const f = file(`@@ -1,3 +1,4 @@
+https.get(url, { rejectUnauthorized: false }, cb);
`);
    const findings = runHeuristics([f]);
    const ssl = findings.find((x) => x.ruleId === 'ssl-verify-disabled');
    expect(ssl).toBeDefined();
    expect(ssl!.severity).toBe('critical');
  });

  it('test-missing fires without test files and stays silent when tests change', () => {
    const src = file(`@@ -1,2 +1,3 @@
+function foo() { return 1; }
`, 'src/lib/foo.ts');
    expect(runHeuristics([src]).some((x) => x.ruleId === 'test-missing')).toBe(true);

    const test = file(`@@ -1,2 +1,3 @@
+it('works', () => {});
`, 'src/lib/foo.test.ts');
    expect(runHeuristics([src, test]).some((x) => x.ruleId === 'test-missing')).toBe(false);
  });

  it('lockfile-only change detected', () => {
    const lock = file(`@@ -1,2 +1,3 @@
+"resolved": "https://registry.npmjs.org/x"
`, 'package-lock.json');
    const findings = runHeuristics([lock]);
    expect(findings.some((x) => x.ruleId === 'lockfile-only')).toBe(true);
  });

  it('large-file-diff fires above 400 changed lines', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `+line${i} = ${i};`);
    const f = file(`@@ -1,2 +1,501 @@\n${lines.join('\n')}`, 'src/big.ts', { additions: 500, deletions: 0 });
    expect(runHeuristics([f]).some((x) => x.ruleId === 'large-file-diff')).toBe(true);
  });

  it('mass-deletion detected for deleted files', () => {
    const f = buildDiffFile({ filename: 'src/old.ts', status: 'removed', additions: 0, deletions: 150, patch: '@@ -1,150 +0,0 @@\n-old code' });
    const findings = runHeuristics([f]);
    const md = findings.find((x) => x.ruleId === 'mass-deletion');
    expect(md).toBeDefined();
    expect(md!.line).toBe(1);
  });

  it('mutedRuleIds removes findings', () => {
    const f = file(`@@ -1,3 +1,4 @@
+console.log("debug");
`);
    expect(runHeuristics([f]).some((x) => x.ruleId === 'console-left')).toBe(true);
    expect(runHeuristics([f], { mutedRuleIds: ['console-left'] }).some((x) => x.ruleId === 'console-left')).toBe(false);
  });

  it('sorts critical before low', () => {
    const f = file(`@@ -1,4 +1,6 @@
+console.log("noise");
+const k = "AKIAIOSFODNN7EXAMPLE";
+eval("1+1");
`);
    const findings = runHeuristics([f]);
    const ids = findings.map((x) => x.severity);
    const firstCritical = ids.indexOf('critical');
    const lastLow = ids.lastIndexOf('low');
    if (firstCritical >= 0 && lastLow >= 0) expect(firstCritical).toBeLessThan(lastLow);
    const sevRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
    for (let i = 1; i < findings.length; i++) {
      expect(sevRank[findings[i - 1].severity]).toBeGreaterThanOrEqual(sevRank[findings[i].severity]);
    }
  });

  it('caps findings per rule per file', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `+console.log("hit ${i}");`);
    const f = file(`@@ -1,2 +1,21 @@\n${lines.join('\n')}`, 'src/noisy.ts', { additions: 20, deletions: 0 });
    const findings = runHeuristics([f]);
    expect(findings.filter((x) => x.ruleId === 'console-left').length).toBe(5);
  });

  it('respects [no-tests] for console-left but still flags secrets in tests', () => {
    const test = file(`@@ -1,3 +1,4 @@
+console.log("debug helper");
`, 'src/app.test.ts');
    expect(runHeuristics([test]).some((x) => x.ruleId === 'console-left')).toBe(false);
    const secretTest = file(`@@ -1,3 +1,4 @@
+const t = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
`, 'src/app.test.ts');
    expect(runHeuristics([secretTest]).some((x) => x.ruleId === 'secret-in-code')).toBe(true);
  });

  it('exports metadata for every rule', () => {
    expect(HEURISTIC_RULES.length).toBe(29);
    expect(HEURISTIC_RULES.map((r) => r.id)).toContain('dom-xss');
    expect(HEURISTIC_RULES.map((r) => r.id)).toContain('chmod-777');
  });

  it('flags python bare except and pickle', () => {
    const f = file(`@@ -1,3 +1,5 @@
+except:
+    pass
+data = pickle.loads(raw)
`, 'src/load.py');
    const findings = runHeuristics([f]);
    expect(findings.some((x) => x.ruleId === 'bare-except-py')).toBe(true);
    expect(findings.some((x) => x.ruleId === 'pickle-load')).toBe(true);
  });
});
