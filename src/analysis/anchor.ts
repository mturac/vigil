// Anchoring & settlement layer — makes LLM findings trustworthy.
//
// LLMs habitually hallucinate line numbers (observed live: the same finding
// came back on lines 7, 5 and 8 across three runs). Vigil therefore NEVER
// trusts an LLM line number blindly:
//
//   1. ANCHOR — every LLM finding must land on a line that actually exists in
//      the diff's ADDED lines. A claimed line that is not an added line gets
//      re-anchored by content similarity between the finding's text and the
//      added-line text; a finding that cannot be anchored at all is dropped.
//
//   2. DEDUP — an LLM finding that corroborates a heuristic finding (same file,
//      nearby line) is folded INTO that finding (source 'heuristic+llm',
//      confidence boosted) instead of being reported twice. Deterministic
//      rules stay the ground truth; the LLM confirms, it does not duplicate.
//
// Pure functions, no I/O — fully unit-testable.
import type { DiffFile, HeuristicFinding, LlmFinding, MergedFinding, Severity } from './types.js';

const SEVERITY_ORDER_LOCAL: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/** High-signal tokens (security/tech vocabulary): worth 3 points when found in a line. */
const KEY_TOKENS = new Set([
  'sql', 'inject', 'injection', 'eval', 'exec', 'md5', 'sha1', 'secret', 'token', 'password',
  'passwd', 'apikey', 'api_key', 'random', 'hardcoded', 'hardcoded', 'weak', 'catch', 'debug',
  'console', 'todo', 'fixme', 'undefined', 'null', 'race', 'await', 'async', 'shell', 'command',
  'query', 'statement', 'prepared', 'parameterized', 'concatenation', 'concat', 'http', 'https',
  'localhost', 'internal', 'private', 'credential', 'key', 'hash', 'unescape', 'innerHTML',
  'dangerouslysetinnerhtml', 'chmod', 'sudo', 'rm', 'delete', 'drop', 'trusted', 'escape',
  'sanitize', 'validation', 'validate', 'timeout', 'retry', 'circular', 'leak', 'memory',
]);

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'code', 'line', 'file', 'should', 'could', 'would', 'there',
  'their', 'where', 'when', 'what', 'which', 'using', 'used', 'uses', 'also', 'been', 'have',
  'them', 'then', 'than', 'into', 'only', 'over', 'more', 'will', 'your', 'they', 'does', 'done',
  'must', 'make', 'made', 'like', 'just', 'some', 'such', 'very', 'much', 'here', 'instead',
  'because', 'allows', 'allow', 'attack', 'attacks', 'source', 'string', 'strings', 'value',
  'values', 'call', 'calls', 'function', 'functions', 'variable', 'variables', 'result',
  'results', 'problem', 'issue', 'exposed', 'exposing', 'expose', 'lead', 'leads', 'potentially',
  'potential', 'unsafe', 'dangerous', 'sensitive', 'credentials', 'without', 'sanitization',
  'consequence', 'consequences', 'fixed', 'fix', 'fixed', 'proper', 'correct', 'better',
  'secure', 'security', 'risk', 'risks', 'vulnerable', 'vulnerability', 'vulnerabilities',
  'malicious', 'injection', 'injected', 'attacker', 'attackers', 'input', 'inputs', 'user',
  'users', 'data', 'database', 'db', 'return', 'returns', 'returned', 'method', 'methods',
  'handler', 'handlers', 'error', 'errors', 'exception', 'exceptions', 'missing', 'lack',
  'lacks', 'needs', 'need', 'needed', 'required', 'requires', 'require', 'ensure', 'ensures',
]);

/** Extract lowercase candidate tokens (>=3 chars) from finding text. */
function tokensOf(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
  const out: string[] = [];
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue;
    // "hardcoded" / "concatenation" style stems: match prefixes against KEY_TOKENS
    out.push(t);
  }
  return [...new Set(out)];
}

function tokenWeight(token: string): number {
  if (KEY_TOKENS.has(token)) return 3;
  // stem-ish match: "inject"/"injected" -> "inject", "concatenation" -> "concat"
  for (const k of KEY_TOKENS) {
    if (k.length >= 4 && (token.startsWith(k) || k.startsWith(token) && token.length >= 4)) return 3;
  }
  return 1;
}

export interface AnchoredLlmFinding extends LlmFinding {
  /** true when the LLM's claimed line was already correct; false when we re-anchored it. */
  reAnchored: boolean;
}

/**
 * Anchor one LLM finding onto the file's actually-added lines.
 *
 * "Exists in the diff" is NOT sufficient: in a fully-added file every line is
 * an added line, so a hallucinated number still "exists". The claimed line's
 * CONTENT must corroborate the finding; when it does not (e.g. a "hardcoded
 * secret" anchored to a blank line), we re-anchor to the best-scoring added
 * line; when nothing corroborates, the finding is dropped.
 *
 * Returns the anchored line number, or null when unanchorable.
 */
export function anchorLine(f: LlmFinding, file: DiffFile): { line: number; reAnchored: boolean } | null {
  const added = file.addedLines;
  if (added.length === 0) return null;

  const tokens = tokensOf(`${f.title} ${f.detail} ${f.suggestion ?? ''}`);

  // Content score of one added line: token overlap, minus a penalty for
  // comment-only lines (a finding about code should point at the code, not
  // the comment above it).
  const scoreOf = (text: string): number => {
    const lower = text.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (lower.includes(t)) score += tokenWeight(t);
    }
    const trimmed = text.trim();
    if (score > 0 && (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*'))) {
      score -= 2;
    }
    return score;
  };

  let bestScore = -1;
  let bestLine = -1;
  for (const a of added) {
    const s = scoreOf(a.text);
    if (s > bestScore) {
      bestScore = s;
      bestLine = a.line;
    }
  }

  // Case 1: the claimed line is an added line AND its content corroborates the
  // finding (or nothing scores clearly better) — trust the LLM.
  if (f.line > 0) {
    const claimed = added.find((a) => a.line === f.line);
    if (claimed) {
      const claimedScore = scoreOf(claimed.text);
      if (claimedScore + 2 >= Math.max(bestScore, 3) && claimedScore >= Math.max(1, bestScore - 2)) {
        return { line: f.line, reAnchored: false };
      }
    }
  }

  // Case 2: re-anchor to the best-corroborating added line.
  // Require a real signal: one keyword hit (weight 3) or better.
  if (bestScore >= 3 && bestLine > 0) {
    return { line: bestLine, reAnchored: true };
  }

  // Case 3: no token evidence at all. If the claimed line exists and nothing
  // contradicts it (e.g. "function too long" findings have no line-level
  // signature), trust the LLM's position.
  if (f.line > 0 && added.some((a) => a.line === f.line) && tokens.length === 0) {
    return { line: f.line, reAnchored: false };
  }

  return null;
}

/**
 * Settle heuristics + LLM findings into the final merged list.
 * - LLM findings are anchored (or dropped).
 * - LLM findings that corroborate a heuristic finding (same path, |Δline| <= 3)
 *   are folded into it: source 'heuristic+llm', confidence boosted, rule keeps
 *   its deterministic ruleId.
 * - Remaining anchored LLM findings become pure-LLM findings.
 */
export function settleFindings(heuristic: HeuristicFinding[], llmRaw: LlmFinding[], files: DiffFile[]): MergedFinding[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const corroborated = new Set<number>(); // indexes into `heuristic`
  const out: MergedFinding[] = [];

  // Start from heuristics (deterministic ground truth).
  for (const h of heuristic) {
    out.push({
      ruleId: h.ruleId, source: 'heuristic', category: h.category, severity: h.severity,
      confidence: h.confidence, path: h.path, line: h.line, message: h.message,
      suggestion: h.suggestion, snippet: h.snippet,
    });
  }

  for (const raw of llmRaw) {
    const file = byPath.get(raw.path);
    if (!file) continue; // path not in diff -> hallucinated file
    const anchored = anchorLine(raw, file);
    if (!anchored) continue; // cannot be placed on an added line -> drop

    // Corroborate the closest heuristic finding on the same path (±3 lines).
    let matchIdx = -1;
    let matchDist = Infinity;
    for (let i = 0; i < heuristic.length; i++) {
      if (heuristic[i].path !== raw.path) continue;
      const dist = Math.abs(heuristic[i].line - anchored.line);
      if (dist <= 3 && dist < matchDist) {
        matchDist = dist;
        matchIdx = i;
      }
    }
    if (matchIdx >= 0) {
      if (!corroborated.has(matchIdx)) {
        corroborated.add(matchIdx);
        const m = out[matchIdx];
        m.source = 'heuristic+llm';
        m.confidence = Math.min(99, m.confidence + 15);
        // If the LLM is more alarmed AND the heuristic was weaker, escalate severity.
        if (SEVERITY_ORDER_LOCAL[raw.severity] > SEVERITY_ORDER_LOCAL[m.severity]) {
          m.severity = raw.severity;
        }
      }
      continue; // folded — do not emit a duplicate row
    }

    // Pure LLM finding (anchored to a real added line).
    out.push({
      ruleId: null, source: 'llm',
      category: raw.category ?? 'quality',
      severity: raw.severity,
      confidence: Math.max(0, Math.min(100, raw.confidence)),
      path: raw.path, line: anchored.line,
      message: `${raw.title}: ${raw.detail}`,
      suggestion: raw.suggestion,
      snippet: file.addedLines.find((a) => a.line === anchored.line)?.text.trim().slice(0, 200),
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER_LOCAL[b.severity] - SEVERITY_ORDER_LOCAL[a.severity] || b.confidence - a.confidence);
}
