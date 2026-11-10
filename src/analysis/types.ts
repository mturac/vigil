// Shared analysis contracts — used by diff parser, heuristics engine, LLM layer,
// report builder and the review pipeline. Keep this file dependency-free.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Category =
  | 'security'
  | 'quality'
  | 'performance'
  | 'tests'
  | 'maintainability'
  | 'style';

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪',
};

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  oldLine?: number; // line number in the old file (del/ctx lines)
  newLine?: number; // line number in the new file (add/ctx lines)
  text: string; // line content WITHOUT the leading +/-/space marker
}

export interface DiffHunk {
  header: string; // e.g. "@@ -10,7 +10,9 @@ export function foo()"
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  path: string; // new path
  previousPath?: string; // set for renames
  changeType: ChangeType;
  additions: number;
  deletions: number;
  isBinary: boolean;
  language: string; // extension-derived, e.g. "ts", "py", "" if none
  hunks: DiffHunk[];
  /** PR-side line numbers of added lines (newLine values of type==='add') */
  addedLines: { line: number; text: string }[];
}

/** A finding produced by the deterministic heuristic engine. */
export interface HeuristicFinding {
  ruleId: string; // stable kebab-case id, e.g. "secret-in-code"
  category: Category;
  severity: Severity;
  confidence: number; // 0..100
  path: string;
  line: number; // PR-side (new file) line number
  message: string; // one clear sentence, markdown allowed
  suggestion?: string; // how to fix, short
  snippet?: string; // the offending line(s), trimmed
}

/** A finding produced by the LLM layer. */
export interface LlmFinding {
  path: string;
  line: number; // PR-side line number
  severity: Severity;
  category?: Category;
  title: string;
  detail: string;
  suggestion?: string;
  confidence: number; // 0..100
}

/** Merged finding stored in DB and rendered in reports. */
export interface MergedFinding {
  ruleId: string | null; // heuristic rule id, or null for pure-LLM findings
  source: 'heuristic' | 'llm';
  category: Category;
  severity: Severity;
  confidence: number;
  path: string;
  line: number;
  message: string;
  suggestion?: string;
  snippet?: string;
}

export interface PullInfo {
  repoFullName: string; // "owner/name"
  provider: 'github' | 'gitlab';
  number: number;
  title: string;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface SimilarFinding {
  path: string;
  ruleId: string | null;
  message: string;
  when: string; // ISO date
  prNumber: number;
}

export interface ReportInput {
  pull: PullInfo;
  files: DiffFile[];
  findings: MergedFinding[];
  /** per-file narrative paragraphs from the LLM, keyed by path (optional) */
  llmWalkthrough?: Record<string, string>;
  similarFindings: SimilarFinding[];
  /** team/channel memory bullets that were applied while reviewing */
  learnings: string[];
  heuristicsOnly: boolean;
  dryRun: boolean;
  reviewUrl?: string;
  /** test-impact: true when source changed but no test files did */
  testsMissing: boolean;
  reviewSeconds: number;
}

export interface StandupMerge { repo: string; title: string; author: string; number: number }
export interface StandupStalePr { repo: string; number: number; title: string; idleHours: number; author?: string }
export interface StandupAlert { source: string; title: string; when: string; url?: string }
export interface StandupDeploy { repo: string; ref: string; at: string }

export interface StandupData {
  since: string; // ISO
  merges: StandupMerge[];
  stale: StandupStalePr[];
  alerts: StandupAlert[];
  deploys: StandupDeploy[];
  channels?: string[];
}

export function riskScore(findings: { severity: Severity; confidence: number }[]): number {
  // 0 (clean) .. 100 (very risky). Weighted by severity & confidence.
  const weights: Record<Severity, number> = { critical: 30, high: 15, medium: 7, low: 3, info: 1 };
  let score = 0;
  for (const f of findings) score += (weights[f.severity] * Math.max(20, Math.min(100, f.confidence))) / 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function languageOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return ext;
}

export function isTestPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|spec)(\/|$)/.test(p) ||
    /\.(test|spec)\.[a-z]+$/.test(p)
  );
}
