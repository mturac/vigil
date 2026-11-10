// Markdown report builders for GitHub PR comments and Slack messages.
// Pure functions: deterministic GitHub-Flavored Markdown, no I/O, no LLM calls.
import type {
  DiffFile,
  MergedFinding,
  ReportInput,
  Severity,
  StandupData,
} from './types.js';
import { SEVERITY_ORDER, isTestPath, riskScore } from './types.js';

/** Input for buildPostmortem(): an incident write-up. */
export interface PostmortemInput {
  title: string;
  severity: string;
  timeline: { at: string; text: string }[];
  rootCause: string;
  impact: string;
  remediation: string[];
  relatedLinks: { label: string; url: string }[];
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

const SEVERITIES_DESC: Severity[] = (Object.keys(SEVERITY_ORDER) as Severity[]).sort(
  (a, b) => SEVERITY_ORDER[b] - SEVERITY_ORDER[a],
);

const WALKTHROUGH_FILE_CAP = 30;
const FILE_GRAPH_MIN_FILES = 2;
const FILE_GRAPH_MAX_FILES = 25;
const SIMILAR_FINDINGS_CAP = 5;
const LEARNINGS_CAP = 5;

function riskLabel(score: number): string {
  if (score < 20) return 'Low';
  if (score < 45) return 'Moderate';
  if (score < 70) return 'High';
  return 'Critical';
}

/** "YYYY-MM-DD" from an ISO-ish string; falls back to the raw input. */
function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Join lines, trim trailing blank lines, guarantee exactly one trailing newline. */
function finish(lines: string[]): string {
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// walkthrough
// ---------------------------------------------------------------------------

/** Added-line patterns that (loosely) indicate function/method/class definitions. */
const DEFINITION_PATTERNS: RegExp[] = [
  /\bfunction\s/, // JS/TS
  /=>/, // arrow functions
  /\bclass\s/, // JS/TS/Python
  /\bdef\s/, // Python
  /\b(?:public|private|protected)\b[^(]*\(/, // Java/C#/TS method declarations
  /\bfunc\s/, // Go/Swift
];

/** Added-line patterns that indicate imports. */
const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\b/, // JS/TS/Java/Go
  /^\s*from\b/, // Python
  /\brequire\(/, // Node
  /^\s*use\b/, // Rust/PHP
];

const EXPORT_PATTERN = /^\s*export\b/;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Deterministic one-line description of the dominant change in a file,
 * computed from the diff alone — no LLM involved.
 */
function describeChange(file: DiffFile): string {
  if (file.changeType === 'renamed' && file.previousPath) {
    return `Renames from ${file.previousPath}.`;
  }
  if (file.isBinary || file.hunks.length === 0) {
    return 'Binary or no textual hunks.';
  }

  const added = file.addedLines.map((l) => l.text);
  const isDefinition = (text: string) => matchesAny(text, DEFINITION_PATTERNS);
  const functions = added.filter(isDefinition).length;
  const imports = added.filter((t) => matchesAny(t, IMPORT_PATTERNS)).length;
  const exports = added.filter((t) => EXPORT_PATTERN.test(t) && !isDefinition(t)).length;

  const facts: string[] = [];
  if (functions > 0) facts.push(plural(functions, 'function'));
  if (imports > 0) facts.push(plural(imports, 'import'));
  if (exports > 0) facts.push(plural(exports, 'exported symbol'));
  if (facts.length > 0) return `Adds ${facts.slice(0, 2).join(' and ')}.`;

  if (file.additions === 0 && file.deletions > 0) {
    return `Removes ${plural(file.deletions, 'line')} (cleanup).`;
  }
  if (file.additions > 0 && file.deletions > 0) {
    return `Modifies ${plural(file.additions + file.deletions, 'line')}.`;
  }
  if (file.additions > 0) return `Adds ${plural(file.additions, 'line')}.`;
  return 'No textual changes.';
}

/**
 * Per-file bullet list describing the diff. Purely deterministic one-liners
 * per file; optional LLM paragraphs (keyed by path) are appended as indented
 * quotes under the matching bullet.
 */
export function buildWalkthrough(files: DiffFile[], llmWalkthrough?: Record<string, string>): string {
  if (files.length === 0) return '_(no changed files)_';

  const lines: string[] = [];
  for (const file of files.slice(0, WALKTHROUGH_FILE_CAP)) {
    lines.push(
      `- **${file.path}** (${file.changeType}, +${file.additions}/-${file.deletions}) — ${describeChange(file)}`,
    );
    const paragraph = llmWalkthrough?.[file.path];
    if (paragraph && paragraph.trim().length > 0) {
      for (const l of paragraph.trim().split('\n')) lines.push(`  > ${l}`);
    }
  }
  if (files.length > WALKTHROUGH_FILE_CAP) {
    lines.push(`- +${files.length - WALKTHROUGH_FILE_CAP} more files`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// mermaid file graph
// ---------------------------------------------------------------------------

function mermaidId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '_');
}

/** Mermaid ids must be unique — append a numeric suffix on collision. */
function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

function mermaidLabel(text: string): string {
  return text.replace(/"/g, "'");
}

/** `graph LR` with a repo root, one node per file, grouped by top-level directory. */
function buildFileGraph(files: DiffFile[]): string {
  const lines: string[] = ['graph LR', '  repo["repo"]'];
  const used = new Set<string>(['repo']);

  const groups = new Map<string, DiffFile[]>();
  for (const file of files) {
    const dir = file.path.includes('/') ? file.path.split('/')[0] : 'root';
    const bucket = groups.get(dir);
    if (bucket) bucket.push(file);
    else groups.set(dir, [file]);
  }

  for (const [dir, group] of groups) {
    lines.push(`  subgraph ${uniqueId(`dir_${mermaidId(dir)}`, used)}["${mermaidLabel(dir)}"]`);
    for (const file of group) {
      const id = uniqueId(`f_${mermaidId(file.path)}`, used);
      lines.push(`    ${id}["${mermaidLabel(file.path)}"]:::file`);
      lines.push(`    repo --> ${id}`);
    }
    lines.push('  end');
  }
  lines.push('  classDef file fill:#eef,stroke:#99b,stroke-width:1px');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// review report
// ---------------------------------------------------------------------------

function renderFinding(f: MergedFinding): string[] {
  const lines = [`- **${f.path}:${f.line}** — ${f.message}`];
  if (f.suggestion) lines.push(`  - Suggestion: ${f.suggestion}`);
  lines.push(`  - Confidence: ${f.confidence}% · source: ${f.source}`);
  return lines;
}

/** Full PR review comment: stats, risk, walkthrough, graph, findings, memory, footer. */
export function buildReviewReport(input: ReportInput): string {
  const { pull } = input;
  const mode = input.heuristicsOnly ? 'heuristics' : 'heuristics+LLM';
  const out: string[] = [];

  // Title + stats + mode.
  out.push('## Vigil Review', '');
  out.push(
    `**${pull.title}** · ${pull.additions} additions · ${pull.deletions} deletions · ${pull.changedFiles} files`,
  );
  out.push(`Mode: ${mode} · Reviewed in ${input.reviewSeconds}s`, '');

  // Risk score.
  const score = riskScore(input.findings);
  out.push(`**Risk score: ${score}/100 — ${riskLabel(score)}**`, '');

  // Findings summary line (zero severities omitted).
  if (input.findings.length === 0) {
    out.push('**No findings. Clean diff.**', '');
  } else {
    const counts = SEVERITIES_DESC.map((sev) => {
      const n = input.findings.filter((f) => f.severity === sev).length;
      return n === 0 ? null : `${n} ${sev}`;
    }).filter((s): s is string => s !== null);
    out.push(counts.join(' · '), '');
  }

  // Walkthrough.
  out.push('### Walkthrough', '', buildWalkthrough(input.files, input.llmWalkthrough), '');

  // File graph (only worth rendering for small-to-medium diffs).
  if (input.files.length >= FILE_GRAPH_MIN_FILES && input.files.length <= FILE_GRAPH_MAX_FILES) {
    out.push('### File graph', '', '```mermaid', buildFileGraph(input.files), '```', '');
  }

  // Findings, most severe first.
  if (input.findings.length > 0) {
    out.push('### Findings', '');
    for (const sev of SEVERITIES_DESC) {
      const findings = input.findings
        .filter((f) => f.severity === sev)
        .sort(
          (a, b) =>
            b.confidence - a.confidence || a.path.localeCompare(b.path) || a.line - b.line,
        );
      if (findings.length === 0) continue;
      out.push(`#### ${sev.toUpperCase()}`, '');
      for (const f of findings) out.push(...renderFinding(f));
      out.push('');
    }
  }

  // Test impact warning.
  if (input.testsMissing) {
    const sourceCount = input.files.filter((f) => !isTestPath(f.path)).length;
    out.push('### Test impact', '');
    out.push(
      sourceCount > 0
        ? `${plural(sourceCount, 'source file')} changed with no test changes in this diff — consider adding or updating tests to cover the new behavior.`
        : 'Source files changed with no test changes in this diff — consider adding or updating tests.',
      '',
    );
  }

  // Similar past findings from PostgreSQL memory.
  if (input.similarFindings.length > 0) {
    out.push('### Similar past findings', '');
    for (const s of input.similarFindings.slice(0, SIMILAR_FINDINGS_CAP)) {
      out.push(`- ${s.path} — ${s.message} (PR #${s.prNumber}, date ${formatDate(s.when)})`);
    }
    out.push('');
  }

  // Team knowledge applied while reviewing.
  if (input.learnings.length > 0) {
    out.push('### Applied team knowledge', '');
    for (const learning of input.learnings.slice(0, LEARNINGS_CAP)) {
      out.push(`- ${learning}`);
    }
    out.push('');
  }

  // Footer.
  out.push('---', '');
  out.push(
    `Generated by **Vigil** — self-hosted SDLC agent · ${mode} · PostgreSQL memory` +
      `${input.dryRun ? ' · dry-run (not posted)' : ''}`,
  );
  if (input.reviewUrl) {
    out.push('', `[Full review in Vigil](${input.reviewUrl})`);
  }

  return finish(out);
}

// ---------------------------------------------------------------------------
// standup report
// ---------------------------------------------------------------------------

/** Daily standup digest: merges, stale PRs, alerts, deploys since a cutoff. */
export function buildStandupReport(data: StandupData): string {
  const since = formatDate(data.since);
  const sections: string[] = [];

  if (data.merges.length > 0) {
    sections.push(
      `### Merged since ${since}`,
      '',
      ...data.merges.map((m) => `- ${m.repo}#${m.number} ${m.title} · ${m.author}`),
    );
  }
  if (data.stale.length > 0) {
    sections.push(
      '### Stale PRs',
      '',
      ...data.stale.map((s) => `- ${s.repo}#${s.number} idle ${s.idleHours}h — ${s.title}`),
    );
  }
  if (data.alerts.length > 0) {
    sections.push(
      '### Alerts',
      '',
      ...data.alerts.map((a) => `- [${a.source}] ${a.title} — ${a.when}`),
    );
  }
  if (data.deploys.length > 0) {
    sections.push(
      '### Deploys',
      '',
      ...data.deploys.map((d) => `- ${d.repo} ${d.ref} at ${d.at}`),
    );
  }

  if (sections.length === 0) {
    return finish([`## Standup — ${since}`, '', '(nothing to report)']);
  }
  return finish([`## Standup — ${since}`, '', sections.join('\n\n')]);
}

// ---------------------------------------------------------------------------
// postmortem
// ---------------------------------------------------------------------------

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Incident postmortem document. */
export function buildPostmortem(input: PostmortemInput): string {
  const out: string[] = [];

  out.push(`# Postmortem: ${input.title}`, '');
  out.push(`**Severity:** ${input.severity}`, '');

  out.push('## Summary', '', input.rootCause, '');
  out.push('## Impact', '', input.impact, '');

  out.push('## Timeline', '', '| Time | Event |', '| --- | --- |');
  for (const t of input.timeline) {
    out.push(`| ${mdCell(t.at)} | ${mdCell(t.text)} |`);
  }
  out.push('');

  out.push('## Root cause', '', input.rootCause, '');

  out.push('## Remediation', '');
  if (input.remediation.length === 0) {
    out.push('_(none)_', '');
  } else {
    input.remediation.forEach((item, i) => out.push(`${i + 1}. ${item}`));
    out.push('');
  }

  out.push('## Links', '');
  if (input.relatedLinks.length === 0) {
    out.push('_(none)_');
  } else {
    for (const link of input.relatedLinks) out.push(`- [${link.label}](${link.url})`);
  }

  return finish(out);
}
