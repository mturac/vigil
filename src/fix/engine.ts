// Fix engine: clone → branch → LLM agent patch loop (read/write/exec tools)
// → sandbox-verified → push → open PR. Every fix run is persisted and auditable.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { simpleGit } from 'simple-git';
import { Sandbox } from '../core/sandbox.js';
import { DEFAULT_CONFIG, type VigilConfig, loadRepoConfig } from '../core/config.js';
import { llm, llmConfigured, type LlmMessage, type LlmToolDef } from '../core/llm.js';
import { Memory } from '../core/memory.js';
import { buildRegistry } from '../connectors/registry.js';
import { logger } from '../core/logger.js';

export interface FixRequest {
  repo: string; // owner/name
  issue: string; // description of what to fix (or an issue URL / finding id)
  baseBranch?: string;
  verifyCommand?: string; // overrides repo config
  dryRun?: boolean; // everything except push+PR
  maxIterations?: number;
  origin?: string; // audit origin string
  cloneUrl?: string; // override the GitHub remote (tests / self-hosted mirrors)
}

export interface FixResult {
  status: 'opened' | 'verified-dry-run' | 'failed' | 'aborted';
  prUrl?: string;
  branch: string;
  log: string[];
  fixRunId: string;
}

const READ_TOOL: LlmToolDef = {
  name: 'read_file',
  description: 'Read a file from the repository working copy. Returns the full content.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path' } }, required: ['path'] },
};
const LIST_TOOL: LlmToolDef = {
  name: 'list_dir',
  description: 'List files/directories in a folder of the repository working copy.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory path ("" for root)' } }, required: ['path'] },
};
const WRITE_TOOL: LlmToolDef = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given full content.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path' }, content: { type: 'string', description: 'Full new file content' } }, required: ['path', 'content'] },
};
const PATCH_TOOL: LlmToolDef = {
  name: 'apply_patch',
  description: 'Apply a unified diff patch to a single file. Use --- / +++ / @@ hunks with context lines; failed application returns an error with the current content.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, patch: { type: 'string', description: 'Unified diff for one file' } }, required: ['path', 'patch'] },
};
const RUN_TOOL: LlmToolDef = {
  name: 'run_command',
  description: 'Run an allowlisted build/test command (e.g. npm test, tsc --noEmit) in the working copy.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};
const DONE_TOOL: LlmToolDef = {
  name: 'finish',
  description: 'Call when the fix is complete and all checks pass. Provide a one-paragraph summary.',
  parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
};

export class FixEngine {
  private sandbox: Sandbox;
  private memory: Memory;

  constructor(private db: PrismaClient, private baseConfig: VigilConfig = DEFAULT_CONFIG) {
    this.sandbox = new Sandbox(baseConfig);
    this.memory = new Memory(db, { enabled: baseConfig.memory.enabled });
  }

  async fix(req: FixRequest): Promise<FixResult> {
    const log: string[] = [];
    const push = (line: string) => { log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`); logger.info({ fix: req.repo }, line); };

    if (!llmConfigured()) throw new Error('fix engine requires an LLM (LLM_PROVIDER + credentials)');

    const github = buildRegistry().get('github')!;
    if (!github.isConfigured() && !req.dryRun) throw new Error('fix engine requires GITHUB_TOKEN to push results');

    // ---- persist run scaffold ------------------------------------------------
    const [owner, name] = req.repo.split('/');
    const repoRow = await this.db.repo.upsert({
      where: { provider_externalId: { provider: 'github', externalId: `github:${req.repo}` } },
      create: { provider: 'github', externalId: `github:${req.repo}`, owner, name },
      update: { updatedAt: new Date() },
    });
    const branch = `${this.baseConfig.fix.branchPrefix}/${Date.now().toString(36)}`;
    const fixRun = await this.db.fixRun.create({
      data: { repoId: repoRow.id, origin: req.origin ?? req.issue, branch, status: 'planning' },
    });
    const patch = async (status: string, extra?: { prUrl?: string }) => {
      await this.db.fixRun.update({
        where: { id: fixRun.id },
        data: { status, log: log.join('\n'), ...(extra?.prUrl ? { prUrl: extra.prUrl } : {}), finishedAt: status === 'failed' || status === 'aborted' ? new Date() : undefined },
      }).catch(() => {});
    };

    // ---- workspace + clone ---------------------------------------------------
    const ws = this.sandbox.newWorkspace('fix');
    try {
      const base = req.baseBranch ?? 'main';
      const token = process.env.GITHUB_TOKEN ?? '';
      const cloneUrl = req.cloneUrl ?? (token
        ? `https://x-access-token:${token}@github.com/${req.repo}.git`
        : `https://github.com/${req.repo}.git`);
      push(`cloning ${req.repo} (branch ${base})`);
      const git = simpleGit();
      await git.clone(cloneUrl, ws, ['--depth', '50', '--branch', base]);
      const repoGit = simpleGit(ws);
      await repoGit.addConfig('user.name', 'vigil-agent');
      await repoGit.addConfig('user.email', 'vigil@localhost');
      await repoGit.checkoutLocalBranch(branch);

      // repo-local config
      const cfg = loadRepoConfig(ws);
      const verifyCommand = req.verifyCommand ?? cfg.fix.verifyCommand;
      const maxIterations = req.maxIterations ?? cfg.fix.maxIterations;

      // ---- agent patch loop ----------------------------------------------------
      await patch('patching');
      const tools = [READ_TOOL, LIST_TOOL, WRITE_TOOL, PATCH_TOOL, RUN_TOOL, DONE_TOOL];
      const messages: LlmMessage[] = [
        {
          role: 'system',
          content: `You are Vigil, an autonomous software engineer. You are working in a git working copy of ${req.repo} on branch ${branch} (base: ${base}). Fix the issue described below with MINIMAL, surgical changes. Prefer apply_patch over rewriting whole files. After changing code, verify with run_command ("${verifyCommand}" or a subset like "tsc --noEmit"). When the fix is complete and checks pass, call finish with a summary. You have at most ${maxIterations} tool iterations.`,
        },
        { role: 'user', content: `Fix this issue:\n\n${req.issue}\n\nWork strictly inside the repository. Do not invent files that do not exist — read first, then patch.` },
      ];

      let iteration = 0;
      let finished = false;
      let summary = '';
      while (iteration < maxIterations * 4 && !finished) {
        iteration++;
        if (iteration > maxIterations && iteration % maxIterations === 1) {
          messages.push({ role: 'user', content: 'Reminder: you are close to the iteration limit — wrap up now and call finish.' });
        }
        const res = await llm.chat(messages, tools, { temperature: 0.1, maxTokens: 4000 });
        if (res.content) push(`llm: ${res.content.slice(0, 200)}`);
        if (res.toolCalls.length === 0) {
          messages.push({ role: 'assistant', content: res.content });
          messages.push({ role: 'user', content: 'Continue — use the tools. Call finish when done.' });
          continue;
        }
        messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          const args = safeParse(call.arguments);
          let out: string;
          try {
            if (call.name === 'read_file') out = this.toolRead(ws, String(args.path ?? ''));
            else if (call.name === 'list_dir') out = this.toolList(ws, String(args.path ?? ''));
            else if (call.name === 'write_file') out = this.toolWrite(ws, String(args.path ?? ''), String(args.content ?? ''));
            else if (call.name === 'apply_patch') out = await this.toolPatch(ws, String(args.path ?? ''), String(args.patch ?? ''));
            else if (call.name === 'run_command') {
              const r = await this.sandbox.exec(String(args.command ?? ''), ws);
              out = `exit=${r.code}${r.timedOut ? ' (TIMEOUT)' : ''}\n--- stdout (tail) ---\n${r.stdout.slice(-3000)}\n--- stderr (tail) ---\n${r.stderr.slice(-1500)}`;
              push(`run: ${String(args.command)} → exit ${r.code}`);
            } else if (call.name === 'finish') {
              finished = true;
              summary = String(args.summary ?? 'Fix applied.');
              out = 'ok';
            } else {
              out = `unknown tool ${call.name}`;
            }
          } catch (e) {
            out = `ERROR: ${(e as Error).message}`;
          }
          messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: out.slice(0, 8000) });
        }
      }

      // ---- verify ---------------------------------------------------------------
      await patch('verifying');
      push(`verifying with: ${verifyCommand}`);
      const verify = await this.sandbox.exec(verifyCommand, ws, { timeoutMs: this.baseConfig.sandbox.timeoutMs });
      push(`verify exit=${verify.code}${verify.timedOut ? ' (TIMEOUT)' : ''}`);
      await repoGit.add('.');
      const diffStat = await repoGit.diff(['--cached', '--stat', base]);

      if (verify.code !== 0) {
        await patch('failed');
        return { status: 'failed', branch, log: [...log, 'verification failed:\n' + verify.stderr.slice(-2000)], fixRunId: fixRun.id };
      }
      if (diffStat.trim().length === 0) {
        await patch('aborted');
        return { status: 'aborted', branch, log: [...log, 'no changes produced — nothing to commit'], fixRunId: fixRun.id };
      }

      // ---- commit + push + PR ----------------------------------------------------
      await repoGit.commit(`fix(vigil): ${req.issue.split('\n')[0].slice(0, 60)}\n\nVerified with: ${verifyCommand}\n\nCloses: ${req.origin ?? req.issue}`);
      if (req.dryRun) {
        await patch('verified-dry-run');
        push('dry-run: not pushing');
        await this.autoLearn(req.repo, req.issue, verifyCommand, summary);
        return { status: 'verified-dry-run', branch, log, fixRunId: fixRun.id };
      }
      await patch('pushing');
      push(`pushing ${branch}`);
      await repoGit.push('origin', branch, ['--set-upstream']);

      const prBody = `## Vigil Fix\n\n**Issue:**\n${req.issue}\n\n**Summary:** ${summary}\n\n**Verification:** \`${verifyCommand}\` — exit 0\n\n\`\`\`\n${diffStat.trim().slice(0, 1500)}\n\`\`\`\n\n---\nAutonomous fix by Vigil (self-hosted SDLC agent). Every command ran in a sandboxed workspace with an allowlisted binary set.`;
      const pr = (await github.runAction('openPr', {
        repo: req.repo, title: `fix: ${req.issue.split('\n')[0].slice(0, 60)}`, head: branch, base, body: prBody,
      })) as { html_url?: string; number?: number };
      push(`opened PR: ${pr.html_url}`);
      await patch('opened', { prUrl: pr.html_url });

      // ---- memory: auto-learn ----------------------------------------------------
      await this.autoLearn(req.repo, req.issue, verifyCommand, summary);

      // link fix run to a pull row when we can find it
      if (pr.number) {
        const pullRow = await this.db.pull.findFirst({ where: { repoId: repoRow.id, number: pr.number } });
        if (pullRow) await this.db.fixRun.update({ where: { id: fixRun.id }, data: { pullId: pullRow.id } });
      }

      return { status: 'opened', prUrl: pr.html_url, branch, log, fixRunId: fixRun.id };
    } catch (e) {
      push(`ERROR: ${(e as Error).message}`);
      await patch('failed');
      return { status: 'failed', branch, log, fixRunId: fixRun.id };
    } finally {
      this.sandbox.releaseWorkspace(ws);
    }
  }

  // ---- tools -----------------------------------------------------------------

  private async autoLearn(repo: string, issue: string, verifyCommand: string, summary: string): Promise<void> {
    if (!this.baseConfig.memory.autoLearn) return;
    await this.memory.remember({
      kind: 'decision',
      title: `Fix workflow for "${issue.split('\n')[0].slice(0, 80)}"`,
      body: `Fix verified with "${verifyCommand}" on ${repo}. Approach: ${summary}`,
      repoFullName: repo,
    });
  }

  private safe(abs: string): string {
    if (abs.includes('..')) throw new Error('path traversal not allowed');
    return abs;
  }

  private toolRead(ws: string, path: string): string {
    const abs = this.safe(join(ws, path));
    if (!existsSync(abs)) return `ERROR: file not found: ${path}`;
    return readFileSync(abs, 'utf8').slice(0, 60_000);
  }

  private toolList(ws: string, path: string): string {
    const abs = this.safe(join(ws, path));
    if (!existsSync(abs)) return `ERROR: not found: ${path}`;
    const entries = readdirSync(abs, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[];
    return entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n').slice(0, 4000);
  }

  private toolWrite(ws: string, path: string, content: string): string {
    const abs = this.safe(join(ws, path));
    writeFileSync(abs, content, 'utf8');
    return `wrote ${content.length} bytes to ${path}`;
  }

  /** Fuzzy unified-diff applier: tries exact hunk offsets, then nearby offsets. */
  private async toolPatch(ws: string, path: string, patchText: string): Promise<string> {
    const abs = this.safe(join(ws, path));
    if (!existsSync(abs)) return `ERROR: file not found: ${path}`;
    const current = readFileSync(abs, 'utf8');
    const lines = current.split('\n');
    const patchLines = patchText.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('diff --git') && !l.startsWith('index '));
    const hunks: { newStart: number; lines: { type: ' ' | '+' | '-'; text: string }[] }[] = [];
    let cur: { newStart: number; lines: { type: ' ' | '+' | '-'; text: string }[] } | null = null;
    for (const line of patchLines) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { cur = { newStart: parseInt(m[1], 10) - 1, lines: [] }; hunks.push(cur); continue; }
      if (!cur) continue;
      if (line.startsWith('+')) cur.lines.push({ type: '+', text: line.slice(1) });
      else if (line.startsWith('-')) cur.lines.push({ type: '-', text: line.slice(1) });
      else if (line.startsWith(' ') || line === '') cur.lines.push({ type: ' ', text: line.replace(/^ /, '') });
    }
    let applied = 0;
    // apply bottom-up so earlier offsets stay valid
    for (const hunk of hunks.reverse()) {
      const hunkLen = hunk.lines.filter((l) => l.type !== '+').length;
      const tryAt = (start: number): boolean => {
        if (start < 0 || start + hunkLen > lines.length) return false;
        let li = start;
        let ok = true;
        const out: string[] = [];
        for (const l of hunk.lines) {
          if (l.type === ' ') {
            if (lines[li] !== l.text) { ok = false; break; }
            out.push(lines[li]); li++;
          } else if (l.type === '-') {
            if (lines[li] !== l.text) { ok = false; break; }
            li++;
          } else {
            out.push(l.text);
          }
        }
        if (!ok) return false;
        lines.splice(start, li - start, ...out);
        return true;
      };
      const wanted = hunk.newStart;
      let done = false;
      for (let off = 0; off <= 25 && !done; off++) {
        for (const s of off === 0 ? [wanted] : [wanted - off, wanted + off]) {
          if (tryAt(s)) { done = true; break; }
        }
      }
      if (done) applied++;
    }
    if (applied === 0) {
      return `ERROR: could not apply any hunk of the patch to ${path}. Current content (first 200 lines):\n${lines.slice(0, 200).join('\n')}`;
    }
    writeFileSync(abs, lines.join('\n'), 'utf8');
    return `applied ${applied}/${hunks.length} hunks to ${path}`;
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
