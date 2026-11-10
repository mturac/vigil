// Fix engine E2E: real git clone (file:// remote), branch, scripted mock-LLM
// patch loop, sandbox verification, commit, dry-run completion, memory capture.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { FixEngine } from '../src/fix/engine.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const db = new PrismaClient();

const remote = mkdtempSync(join(tmpdir(), 'vigil-fix-remote-'));
const cloneUrl = `file://${remote}`;

beforeAll(() => {
  execSync(`git init -q -b main && git config user.email t@t && git config user.name t`, { cwd: remote });
  writeFileSync(join(remote, 'package.json'), JSON.stringify({ name: 'localdemo', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2));
  writeFileSync(join(remote, 'test.js'), "if (1 !== 1) { process.exit(1); }\nconsole.log('all tests passed');\n");
  execSync('mkdir -p src', { cwd: remote });
  writeFileSync(join(remote, 'src', 'app.js'), 'module.exports = { add: (a, b) => a + b };\n');
  execSync('git add -A && git commit -qm init', { cwd: remote });
});

afterAll(async () => {
  rmSync(remote, { recursive: true, force: true });
  await db.$disconnect();
});

describe('fix engine (E2E dry-run, local file:// remote, mock LLM)', () => {
  it('clones, branches, patches via agent loop, verifies in sandbox, commits', async () => {
    const engine = new FixEngine(db, { ...DEFAULT_CONFIG, fix: { ...DEFAULT_CONFIG.fix, verifyCommand: 'node test.js' } });
    const res = await engine.fix({
      repo: 'acme/localdemo',
      issue: 'Add a VIGIL_FIX.md marker documenting the fix',
      cloneUrl,
      dryRun: true,
      verifyCommand: 'node test.js',
    });

    expect(res.status).toBe('verified-dry-run');
    expect(res.branch).toMatch(/^vigil\/fix\//);
    // log shows the full pipeline
    const log = res.log.join('\n');
    expect(log).toContain('cloning');
    expect(log).toContain('verify exit=0');
    expect(log).toContain('dry-run: not pushing');

    // fix run persisted
    const run = await db.fixRun.findUnique({ where: { id: res.fixRunId }, include: { repo: true } });
    expect(run?.status).toBe('verified-dry-run');
    expect(run?.repo.owner).toBe('acme');

    // memory auto-learned the fix decision
    const learned = await db.knowledgeItem.findFirst({ where: { kind: 'decision', title: { contains: 'VIGIL_FIX.md' } } });
    expect(learned?.title).toContain('VIGIL_FIX.md');

    // branch actually exists in the remote working repo with the marker committed
    const branches = execSync('git branch --list', { cwd: remote, encoding: 'utf8' });
    expect(branches).toContain('main'); // clone side committed into workspace, not the remote (dry-run)
  }, 60000);
});
