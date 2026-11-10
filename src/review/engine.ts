// Review engine: fetch PR diff → heuristics → (optional) LLM layer → persist → post.
// Works in "dry-run" (no GitHub token) mode for local/offline use.
import type { PrismaClient } from '@prisma/client';
import { buildDiffFile, buildDiffFiles, type RawFileEntry } from '../analysis/diff.js';
import { runHeuristics } from '../analysis/heuristics.js';
import { buildReviewReport, buildWalkthrough } from '../analysis/report.js';
import type { DiffFile, LlmFinding, MergedFinding, PullInfo, SimilarFinding } from '../analysis/types.js';
import { isTestPath, riskScore, SEVERITY_ORDER, type Severity } from '../analysis/types.js';
import { pathIgnored, loadRepoConfig, type VigilConfig, DEFAULT_CONFIG } from '../core/config.js';
import { llm, costOf, llmConfigured } from '../core/llm.js';
import { Memory } from '../core/memory.js';
import { Sandbox } from '../core/sandbox.js';
import { buildRegistry } from '../connectors/registry.js';
import { logger } from '../core/logger.js';

export interface ReviewRequest {
  repo: string; // owner/name
  number: number;
  dryRun?: boolean;
  /** override where the diff comes from (tests / offline) */
  fakePull?: PullInfo;
  fakeFiles?: RawFileEntry[];
  scopeId?: string;
}

export interface ReviewResult {
  reviewId: string | null;
  postedUrl: string | null;
  riskScore: number;
  findings: MergedFinding[];
  report: string;
  llmUsed: boolean;
}

const SEV_THRESHOLD: Record<string, number> = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };

export class ReviewEngine {
  private memory: Memory;

  constructor(
    private db: PrismaClient,
    private baseConfig: VigilConfig = DEFAULT_CONFIG,
  ) {
    this.memory = new Memory(db, { enabled: baseConfig.memory.enabled });
  }

  async review(req: ReviewRequest): Promise<ReviewResult> {
    const started = Date.now();
    const [owner, name] = req.repo.split('/');
    const github = buildRegistry().get('github')!;
    const canUseGithub = github.isConfigured() && !req.fakePull;

    // ---- fetch PR + files --------------------------------------------------
    let pull: PullInfo;
    let rawFiles: RawFileEntry[];
    if (req.fakePull && req.fakeFiles) {
      pull = req.fakePull;
      rawFiles = req.fakeFiles;
    } else {
      const pr = (await github.runAction('getPr', { repo: req.repo, number: req.number })) as {
        title: string; user: { login: string }; base: { ref: string }; head: { ref: string; sha: string };
        additions: number; deletions: number; changed_files: number; state: string;
      };
      pull = {
        repoFullName: req.repo,
        provider: 'github',
        number: req.number,
        title: pr.title,
        author: pr.user?.login ?? 'unknown',
        baseRef: pr.base.ref,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
      };
      rawFiles = (await github.runAction('getPrFiles', { repo: req.repo, number: req.number })) as unknown as RawFileEntry[];
    }

    // ---- config: repo-local overrides via .vigil.yml at repo root ----------
    let cfg = this.baseConfig;
    if (canUseGithub) {
      try {
        const dot = (await github.runAction('getRepoContent', { repo: req.repo, path: '.vigil.yml', ref: pull.headRef })) as { decoded?: boolean; content?: string };
        if (dot?.decoded && dot.content) {
          const { loadConfigFromString } = await import('../core/config.js');
          cfg = loadConfigFromString(dot.content);
        }
      } catch { /* no repo config — defaults */ }
    }

    // ---- build structured diff --------------------------------------------
    let files: DiffFile[] = buildDiffFiles(rawFiles);
    const ignored = files.filter((f) => pathIgnored(cfg, f.path));
    files = files.filter((f) => !pathIgnored(cfg, f.path));

    // ---- heuristics --------------------------------------------------------
    const heuristicFindings = cfg.heuristics.enabled
      ? runHeuristics(files, { mutedRuleIds: cfg.heuristics.mutedRules })
      : [];

    // ---- LLM layer ---------------------------------------------------------
    const llmFindings: LlmFinding[] = [];
    const llmWalkthrough: Record<string, string> = {};
    const llmOn = cfg.llm.review && llmConfigured() && files.length > 0;
    if (llmOn) {
      try {
        const res = await this.llmReview(files, pull);
        llmFindings.push(...res.findings);
        Object.assign(llmWalkthrough, res.walkthrough);
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'llm review layer failed — continuing heuristics-only');
      }
    }

    // ---- merge -------------------------------------------------------------
    const merged: MergedFinding[] = [
      ...heuristicFindings.map((h) => ({
        ruleId: h.ruleId, source: 'heuristic' as const, category: h.category, severity: h.severity,
        confidence: h.confidence, path: h.path, line: h.line, message: h.message, suggestion: h.suggestion, snippet: h.snippet,
      })),
      ...llmFindings
        .filter((f) => files.some((file) => file.path === f.path))
        .map((f) => ({
          ruleId: null, source: 'llm' as const,
          category: (f.category ?? (['security', 'quality', 'performance', 'tests', 'maintainability', 'style'].includes(f.severity) ? 'quality' : 'quality')) as MergedFinding['category'],
          severity: f.severity, confidence: Math.max(0, Math.min(100, f.confidence)), path: f.path, line: f.line,
          message: `${f.title}: ${f.detail}`, suggestion: f.suggestion,
        })),
    ]
      .filter((f) => SEV_THRESHOLD[f.severity] >= SEV_THRESHOLD[cfg.review.minSeverity])
      .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.confidence - a.confidence);

    const risk = riskScore(merged);

    // ---- memory + similar findings ----------------------------------------
    const learnings = await this.memory.recall({ repoFullName: req.repo }, 5);
    const similarFindings = await this.similarFindings(req.repo, merged);

    // ---- persist -----------------------------------------------------------
    const repo = await this.upsertRepo(req.repo, pull.provider);
    const pullRow = await this.db.pull.upsert({
      where: { repoId_number: { repoId: repo.id, number: req.number } },
      create: {
        repoId: repo.id, number: req.number, title: pull.title, author: pull.author, state: 'open',
        headRef: pull.headRef, baseRef: pull.baseRef, headSha: pull.headSha,
        additions: pull.additions, deletions: pull.deletions, changedFiles: pull.changedFiles,
      },
      update: {
        title: pull.title, author: pull.author, headRef: pull.headRef, headSha: pull.headSha,
        additions: pull.additions, deletions: pull.deletions, changedFiles: pull.changedFiles, updatedAt: new Date(),
      },
    });

    const testsMissing = cfg.review.tests.missingTestWarning && files.some((f) => f.changeType !== 'deleted' && !isTestPath(f.path) && !ignored.some((i) => i.path === f.path) && !['json', 'yml', 'yaml', 'md', 'txt', 'toml', 'lock', ''].includes(f.language)) && !files.some((f) => isTestPath(f.path));

    const report = buildReviewReport({
      pull,
      files,
      findings: merged,
      llmWalkthrough,
      similarFindings,
      learnings,
      heuristicsOnly: !llmOn,
      dryRun: !!req.dryRun,
      testsMissing,
      reviewSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
    });

    const reviewRow = await this.db.review.create({
      data: {
        pullId: pullRow.id,
        headSha: pull.headSha,
        status: 'dry-run',
        summary: report,
        walkthrough: buildWalkthrough(files, llmWalkthrough),
        riskScore: risk,
        llmUsed: llmOn,
        findingsCount: merged.length,
        criticalCount: merged.filter((f) => f.severity === 'critical').length,
        highCount: merged.filter((f) => f.severity === 'high').length,
      },
    });
    for (const f of merged) {
      await this.db.finding.create({
        data: {
          reviewId: reviewRow.id, ruleId: f.ruleId, source: f.source, category: f.category,
          severity: f.severity, confidence: f.confidence, path: f.path, line: f.line,
          message: f.message, suggestion: f.suggestion, snippet: f.snippet,
        },
      });
    }

    // ---- post --------------------------------------------------------------
    let postedUrl: string | null = null;
    if (!req.dryRun && canUseGithub) {
      try {
        const worst = merged[0]?.severity;
        const wantEvent = worst && SEV_THRESHOLD[worst] >= SEV_THRESHOLD[cfg.review.requestChangesAt] && cfg.review.requestChangesAt !== 'never'
          ? 'REQUEST_CHANGES'
          : 'COMMENT';
        const inline = merged
          .filter((f) => f.source === 'heuristic' || f.line > 0)
          .slice(0, cfg.review.maxInlineComments)
          .map((f) => ({
            path: f.path,
            line: f.line,
            body: `**${f.severity.toUpperCase()}** · ${f.category} · ${f.source}\n\n${f.message}${f.suggestion ? `\n\n> ${f.suggestion}` : ''}${f.ruleId ? `\n\n\`${f.ruleId}\`` : ''}`,
          }));
        let event = wantEvent;
        let created: { html_url?: string };
        try {
          created = (await github.runAction('createPrReview', {
            repo: req.repo, number: req.number, event, body: report, comments: inline,
          })) as { html_url?: string };
        } catch (e) {
          // GitHub rejects REQUEST_CHANGES on the token owner's own PRs — fall back to COMMENT.
          if (event === 'REQUEST_CHANGES' && /own pull request/i.test((e as Error).message)) {
            event = 'COMMENT';
            created = (await github.runAction('createPrReview', {
              repo: req.repo, number: req.number, event, body: report, comments: inline,
            })) as { html_url?: string };
          } else {
            throw e;
          }
        }
        postedUrl = created.html_url ?? `https://github.com/${req.repo}/pull/${req.number}#pullrequestreview-${Date.now()}`;
        await this.db.review.update({ where: { id: reviewRow.id }, data: { status: 'posted', postedUrl } });
      } catch (e) {
        logger.error({ err: (e as Error).message }, 'failed to post review to github');
        await this.db.review.update({ where: { id: reviewRow.id }, data: { status: 'failed' } });
      }
    }

    return { reviewId: reviewRow.id, postedUrl, riskScore: risk, findings: merged, report, llmUsed: llmOn };
  }

  // ---------------------------------------------------------------------------

  private async llmReview(files: DiffFile[], pull: PullInfo): Promise<{ findings: LlmFinding[]; walkthrough: Record<string, string> }> {
    const budgetFiles = files.slice(0, 20);
    const diffText = budgetFiles
      .map((f) => {
        const hunks = f.hunks.map((h) => h.header + '\n' + h.lines.map((l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text).join('\n')).join('\n');
        return `FILE: ${f.path} (${f.changeType}, +${f.additions}/-${f.deletions})\n${hunks}`;
      })
      .join('\n\n')
      .slice(0, 90_000);

    const system = `You are Vigil, a meticulous senior code reviewer. Analyze pull request diffs and respond with STRICT JSON only (no markdown fences, no prose outside JSON):
{"walkthrough": {"<path>": "<1-3 sentence plain-English summary of what changed and why it matters>"},
 "findings": [{"path": "<file>", "line": <number in the NEW file>, "severity": "critical|high|medium|low|info", "category": "security|quality|performance|tests|maintainability|style", "title": "<short title>", "detail": "<what is wrong and the consequence>", "suggestion": "<how to fix>", "confidence": <0-100>}]}
Rules: only report REAL problems introduced by the added lines; do not restate the diff; do not report style nits already obvious; keep findings under 8; line numbers must exist in the new file.`;
    const user = `PR #${pull.number}: ${pull.title}\nAuthor: ${pull.author}\nBranch: ${pull.headRef} → ${pull.baseRef}\n\nDIFF:\n${diffText}`;

    const res = await llm.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], undefined, { temperature: 0.1, maxTokens: 3000 });

    const parsed = this.parseLlmJson(res.content);
    if (!parsed) return { findings: [], walkthrough: {} };
    const findings: LlmFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f: unknown): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as Record<string, unknown>).path === 'string')
          .map((f) => ({
            path: String(f.path),
            line: typeof f.line === 'number' ? f.line : 1,
            severity: (['critical', 'high', 'medium', 'low', 'info'].includes(String(f.severity)) ? String(f.severity) : 'medium') as Severity,
            category: (['security', 'quality', 'performance', 'tests', 'maintainability', 'style'].includes(String(f.category)) ? String(f.category) : 'quality') as LlmFinding['category'],
            title: String(f.title ?? 'Finding'),
            detail: String(f.detail ?? ''),
            suggestion: f.suggestion ? String(f.suggestion) : undefined,
            confidence: typeof f.confidence === 'number' ? f.confidence : 70,
          }))
      : [];
    const walkthrough: Record<string, string> = {};
    if (parsed.walkthrough && typeof parsed.walkthrough === 'object') {
      for (const [k, v] of Object.entries(parsed.walkthrough as Record<string, unknown>)) {
        if (typeof v === 'string') walkthrough[k] = v;
      }
    }
    return { findings, walkthrough };
  }

  private parseLlmJson(text: string): { findings?: unknown; walkthrough?: unknown } | null {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as { findings?: unknown; walkthrough?: unknown };
    } catch {
      return null;
    }
  }

  private async similarFindings(repo: string, current: MergedFinding[]): Promise<SimilarFinding[]> {
    if (current.length === 0) return [];
    const repoRow = await this.db.repo.findFirst({ where: { owner: repo.split('/')[0], name: repo.split('/')[1] } });
    if (!repoRow) return [];
    const rules = [...new Set(current.map((f) => f.ruleId).filter((r): r is string => !!r))].slice(0, 5);
    const rows = await this.db.finding.findMany({
      where: { ruleId: { in: rules }, review: { pull: { repoId: repoRow.id } }, createdAt: { gte: new Date(Date.now() - 90 * 86400_000) } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { review: { include: { pull: true } } },
    });
    return rows.map((r) => ({ path: r.path, ruleId: r.ruleId, message: r.message.slice(0, 200), when: r.createdAt.toISOString(), prNumber: r.review.pull.number }));
  }

  private async upsertRepo(full: string, provider: string) {
    const [owner, name] = full.split('/');
    const externalId = `${provider}:${full}`;
    return this.db.repo.upsert({
      where: { provider_externalId: { provider, externalId } },
      create: { provider, externalId, owner, name },
      update: { updatedAt: new Date() },
    });
  }
}

/** Standalone local scan (no PR): run heuristics over a directory diff vs base. */
export async function scanWorkingTree(dir: string, db: PrismaClient): Promise<MergedFinding[]> {
  const { simpleGit } = await import('simple-git');
  const git = simpleGit(dir);
  const diff = await git.diff(['HEAD']);
  const files: DiffFile[] = [];
  const perFile = diff.split('diff --git ');
  for (const chunk of perFile) {
    if (!chunk.trim()) continue;
    const pathMatch = chunk.match(/^a\/(\S+) b\/(\S+)/);
    if (!pathMatch) continue;
    const raw = buildDiffFile({ filename: pathMatch[2], status: 'modified', additions: 0, deletions: 0, patch: 'diff --git ' + chunk });
    files.push(raw);
  }
  const findings = runHeuristics(files);
  return findings.map((h) => ({
    ruleId: h.ruleId, source: 'heuristic' as const, category: h.category, severity: h.severity,
    confidence: h.confidence, path: h.path, line: h.line, message: h.message, suggestion: h.suggestion, snippet: h.snippet,
  }));
}
