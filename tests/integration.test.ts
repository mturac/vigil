// Integration tests: real PostgreSQL (embedded), mock LLM, mock MCP server.
// These verify the actual product flows: queue, governance, memory, review
// engine persistence, chat agent loop, sandbox, cron matching, MCP client.
process.env.DATABASE_URL = 'postgresql://vigil:vigil@localhost:5433/vigil';
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-1';
process.env.GITHUB_TOKEN = ''; // force deterministic dry-run paths
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.DASHBOARD_PASSWORD = '';

import { beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Queue } from '../src/core/queue.js';
import { Governor } from '../src/core/governance.js';
import { Memory } from '../src/core/memory.js';
import { Sandbox } from '../src/core/sandbox.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { cronMatches } from '../src/daemon.js';
import { ReviewEngine } from '../src/review/engine.js';
import { ChatAgent } from '../src/chat/agent.js';
import { listMcpTools, createMcpConnector } from '../src/connectors/mcp.js';
import type { RawFileEntry } from '../src/analysis/diff.js';

const db = new PrismaClient();

beforeAll(async () => {
  // clean slate
  for (const table of ['RunStep', 'Run', 'ChatMessage', 'Conversation', 'Finding', 'Review', 'Pull', 'FixRun', 'KnowledgeItem', 'Job', 'Automation', 'Repo', 'Scope']) {
    await db.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`);
  }
});

const FAKE_PATCH = `@@ -1,4 +1,7 @@
 const a = 1;
+const awsKey = "AKIAIOSFODNN7EXAMPLE";
+eval("dangerous");
+console.log("debug");
 const b = 2;`;

const fakeFiles: RawFileEntry[] = [
  { filename: 'src/service.ts', status: 'modified', additions: 4, deletions: 1, patch: FAKE_PATCH },
];

const fakePull = {
  repoFullName: 'acme/demo', provider: 'github' as const, number: 42, title: 'Add service',
  author: 'dev', baseRef: 'main', headRef: 'feat/x', headSha: 'abc123',
  additions: 4, deletions: 1, changedFiles: 1,
};

describe('governance', () => {
  it('default scope allows everything when allowlists empty', async () => {
    const gov = new Governor(db);
    const scope = await gov.resolveScope({ channelKey: 'console:default' });
    expect(scope.isDefault).toBe(true);
    const d = gov.check(scope, { userId: 'x', repo: 'acme/demo', connector: 'github' });
    expect(d.allowed).toBe(true);
  });

  it('blocks users/repos outside allowlist', async () => {
    const scope = await db.scope.create({
      data: { name: 'restricted', allowedUsers: ['alice'], allowedRepos: ['acme/*'], allowedConnectors: ['github'] },
    });
    const gov = new Governor(db);
    expect(gov.check(scope, { userId: 'bob' }).allowed).toBe(false);
    expect(gov.check(scope, { userId: 'alice', repo: 'other/x' }).allowed).toBe(false);
    expect(gov.check(scope, { userId: 'alice', repo: 'acme/x' }).allowed).toBe(true);
    expect(gov.check(scope, { userId: 'alice', repo: 'acme/x', connector: 'sentry' }).allowed).toBe(false);
  });

  it('enforces daily spend limits', async () => {
    const scope = await db.scope.create({ data: { name: 'budget', spendLimitPerDayUsd: 0.01 } });
    await db.run.create({ data: { kind: 'chat', goal: 't', scopeId: scope.id, costUsd: 0.05, status: 'succeeded' } });
    const gov = new Governor(db);
    await expect(gov.assertSpend(scope, 0.01)).rejects.toThrow(/spend limit/);
    await expect(gov.assertSpend(scope, 0)).rejects.toThrow(/spend limit/);
  });
});

describe('memory', () => {
  it('remembers and recalls across scopes', async () => {
    const mem = new Memory(db, { enabled: true });
    await mem.remember({ kind: 'decision', title: 'Use pnpm', body: 'Team decided pnpm over npm in Q1', repoFullName: 'acme/demo' });
    await mem.remember({ kind: 'fact', title: 'Global fact', body: 'Deploys happen at 14:00 UTC' });
    const recalled = await mem.recall({ repoFullName: 'acme/demo' });
    expect(recalled.some((r) => r.includes('pnpm'))).toBe(true);
    expect(recalled.some((r) => r.includes('14:00'))).toBe(true);
    const otherRepo = await mem.recall({ repoFullName: 'other/repo' });
    expect(otherRepo.some((r) => r.includes('pnpm'))).toBe(false);
  });
});

describe('queue', () => {
  it('processes jobs with retry and dedupe', async () => {
    const handled: string[] = [];
    const queue = new Queue(db, { pollMs: 100, batchSize: 5 });
    queue.register({
      type: 'test.echo',
      handle: async (payload) => { handled.push(String(payload.value)); },
    });
    const id1 = await queue.enqueue('test.echo', { value: 'a' });
    expect(id1).toBeTruthy();
    const id2 = await queue.enqueue('test.echo', { value: 'a' }, { dedupeKey: 'same' });
    const id3 = await queue.enqueue('test.echo', { value: 'a' }, { dedupeKey: 'same' });
    expect(id2).toBeTruthy();
    expect(id3).toBeNull(); // deduped
    queue.start();
    await new Promise((r) => setTimeout(r, 1500));
    queue.stop();
    expect(handled).toEqual(['a', 'a']);
    const done = await db.job.count({ where: { status: 'done' } });
    expect(done).toBeGreaterThanOrEqual(2);
  });

  it('retries failed jobs up to maxAttempts', async () => {
    let attempts = 0;
    const queue = new Queue(db, { pollMs: 50, batchSize: 5 });
    queue.register({
      type: 'test.failing',
      handle: async () => { attempts++; throw new Error('boom'); },
    });
    const id = await queue.enqueue('test.failing', {}, {});
    await db.job.update({ where: { id: id! }, data: { maxAttempts: 1 } });
    queue.start();
    await new Promise((r) => setTimeout(r, 600));
    queue.stop();
    const failed = await db.job.findFirst({ where: { type: 'test.failing' } });
    expect(failed?.status).toBe('failed');
    expect(failed?.lastError).toContain('boom');
    expect(attempts).toBe(1);
  });
});

describe('review engine (dry-run, heuristics + mock LLM)', () => {
  it('runs full pipeline and persists review + findings', async () => {
    const engine = new ReviewEngine(db, DEFAULT_CONFIG);
    const res = await engine.review({ repo: 'acme/demo', number: 42, fakePull, fakeFiles, dryRun: true });
    expect(res.llmUsed).toBe(true); // mock provider counts as configured
    expect(res.findings.some((f) => f.ruleId === 'secret-in-code')).toBe(true);
    expect(res.findings.some((f) => f.ruleId === 'eval-usage')).toBe(true);
    expect(res.riskScore).toBeGreaterThan(0);
    expect(res.report).toContain('Vigil Review');
    expect(res.report).toContain('Walkthrough');
    // persisted
    const review = await db.review.findUnique({ where: { id: res.reviewId! }, include: { findings: true, pull: { include: { repo: true } } } });
    expect(review).toBeTruthy();
    expect(review!.status).toBe('dry-run');
    expect(review!.findings.length).toBe(res.findings.length);
    expect(review!.pull.repo.owner).toBe('acme');
    // second review of same PR upserts pull, creates second review
    const res2 = await engine.review({ repo: 'acme/demo', number: 42, fakePull, fakeFiles, dryRun: true });
    expect(res2.reviewId).not.toBe(res.reviewId);
    const pulls = await db.pull.count({ where: { repo: { owner: 'acme', name: 'demo' } } });
    expect(pulls).toBe(1);
    // similar findings should now appear for a third review
    const res3 = await engine.review({ repo: 'acme/demo', number: 42, fakePull, fakeFiles, dryRun: true });
    expect(res3.report).toContain('Similar past findings');
  });
});

describe('chat agent (mock LLM)', () => {
  it('runs a full conversational turn with persistence and cost tracking', async () => {
    const agent = new ChatAgent(db, DEFAULT_CONFIG);
    const res = await agent.handle({ text: 'hello vigil, introduce yourself and your capabilities', channelKey: 'console:default', channel: 'console' });
    expect(res.reply).toContain('MOCK RESPONSE');
    expect(res.runId).toBeTruthy();
    // messages persisted
    const conv = await db.conversation.findUnique({ where: { id: res.conversationId }, include: { messages: true } });
    expect(conv!.messages.length).toBe(2); // user + assistant
    expect(conv!.messages.some((m) => m.role === 'assistant')).toBe(true);
    // run + steps persisted
    const run = await db.run.findUnique({ where: { id: res.runId }, include: { steps: true } });
    expect(run!.kind).toBe('chat');
    expect(run!.steps.length).toBeGreaterThan(0);
    expect(run!.steps.some((s) => s.kind === 'llm')).toBe(true);
    // second turn continues the same conversation
    const res2 = await agent.handle({ text: 'thanks', channelKey: 'console:default', channel: 'console' });
    expect(res2.conversationId).toBe(res.conversationId);
    const conv2 = await db.conversation.findUnique({ where: { id: res.conversationId }, include: { messages: true } });
    expect(conv2!.messages.length).toBe(4);
  });

  it('governance rejects users outside allowlist', async () => {
    const scope = await db.scope.create({ data: { name: 'cli-only', allowedUsers: ['carol'] } });
    const conv = await db.conversation.create({ data: { channel: 'console', channelKey: 'console:guarded', scopeId: scope.id } });
    const agent = new ChatAgent(db, DEFAULT_CONFIG);
    const res = await agent.handle({ text: 'hi', userId: 'mallory', channelKey: 'console:guarded', channel: 'console' });
    expect(res.reply).toContain('not in scope');
    void conv;
  });
});

describe('sandbox', () => {
  const cfg = { ...DEFAULT_CONFIG, sandbox: { ...DEFAULT_CONFIG.sandbox, profile: 'local' as const } };
  it('executes allowlisted commands', async () => {
    const sb = new Sandbox(cfg);
    const r = await sb.exec('echo hello-vigil', '/tmp', { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hello-vigil');
  });
  it('blocks non-allowlisted binaries', async () => {
    const sb = new Sandbox(cfg);
    const r = await sb.exec('whoami', '/tmp', { timeoutMs: 5000 });
    expect(r.code).toBe(126);
    expect(r.stderr).toContain('not in the allowlist');
  });
  it('blocks deny patterns', async () => {
    const sb = new Sandbox(cfg);
    const r = await sb.exec('sh -c "curl http://evil.example"', '/tmp', { timeoutMs: 5000 });
    expect([126, 1]).toContain(r.code);
  });
});

describe('cron matcher', () => {
  it('matches standard expressions', () => {
    const at = (h: number, m: number) => new Date(2026, 10, 9, h, m, 0);
    expect(cronMatches('0 9 * * 1-5', at(9, 0))).toBe(true);   // weekdays 9:00
    expect(cronMatches('0 9 * * 1-5', at(9, 30))).toBe(false);
    expect(cronMatches('*/15 * * * *', at(10, 45))).toBe(true);
    expect(cronMatches('*/15 * * * *', at(10, 50))).toBe(false);
    expect(cronMatches('0 * * * *', at(14, 0))).toBe(true);
  });
});

describe('mcp client', () => {
  const serverScript = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const tools = [{ name: 'echo', description: 'echoes text', inputSchema: { type: 'object' } }];
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
function handle(line) {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') respond(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } });
  else if (msg.method === 'tools/list') respond(msg.id, { tools });
  else if (msg.method === 'tools/call') respond(msg.id, { content: [{ type: 'text', text: 'echo: ' + (msg.params?.arguments?.text ?? '') }] });
  else if (msg.id !== undefined) respond(msg.id, {});
}
setInterval(() => { const i = buf.indexOf('\\n'); if (i >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } }, 10);
`;
  const cfgServer = { name: 'mock', command: process.execPath, args: ['-e', serverScript] };

  it('lists tools from a real spawned MCP server', async () => {
    const tools = await listMcpTools(cfgServer);
    expect(tools.some((t) => t.name === 'echo')).toBe(true);
  }, 20000);

  it('calls tools through the connector interface', async () => {
    const conn = createMcpConnector(cfgServer);
    expect(conn.id).toBe('mcp.mock');
    const out = await conn.runAction('echo', { text: 'hello mcp' });
    expect(String(out)).toContain('echo: hello mcp');
    const h = await conn.health();
    expect(h.ok).toBe(true);
  }, 20000);
});

describe('standup repo resolution (REPOS env → DB fallback)', () => {
  it('falls back to repos known from the Pull/Repo tables when REPOS is unset', async () => {
    await db.repo.create({
      data: {
        provider: 'github', externalId: 'standup-fallback-test', owner: 'acme', name: 'known-repo',
        pulls: { create: { number: 7, title: 'past reviewed PR', author: 'someone', state: 'open', headRef: 'b1', headSha: 'a'.repeat(40), baseRef: 'main', updatedAt: new Date() } },
      },
    });
    const prev = process.env.REPOS;
    delete process.env.REPOS;
    try {
      const { reposFromEnvOrDb } = await import('../src/chat/skills.js');
      const repos = await reposFromEnvOrDb({ db, cfg: DEFAULT_CONFIG });
      expect(repos).toContain('acme/known-repo');
    } finally {
      if (prev !== undefined) process.env.REPOS = prev;
    }
  });

  it('REPOS env still wins over the database', async () => {
    const prev = process.env.REPOS;
    process.env.REPOS = 'env/first,env/second';
    try {
      const { reposFromEnvOrDb } = await import('../src/chat/skills.js');
      const repos = await reposFromEnvOrDb({ db, cfg: DEFAULT_CONFIG });
      expect(repos).toEqual(['env/first', 'env/second']);
    } finally {
      if (prev !== undefined) process.env.REPOS = prev; else delete process.env.REPOS;
    }
  });
});
