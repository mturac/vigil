// Dashboard view models — plain data rendered by src/dashboard/views.ts.
// Routes build these from Prisma; views are pure functions.

export interface ReviewRow {
  id: string;
  repo: string; // owner/name
  pr: number;
  title: string;
  risk: number;
  findings: number;
  critical: number;
  high: number;
  llmUsed: boolean;
  at: string;
  url?: string;
}

export interface RunRow {
  id: string;
  kind: string;
  goal: string; // truncated by route
  status: string;
  costUsd: number;
  wallMs: number;
  steps: number;
  channel: string;
  at: string;
}

export interface RepoRow {
  id: string;
  name: string;
  provider: string;
  openPulls: number;
  reviews30d: number;
  critical30d: number;
  high30d: number;
  lastReviewAt?: string;
}

export interface OverviewVM {
  totals: {
    reviews: number;
    findings: number;
    critical: number;
    high: number;
    runs: number;
    costUsd: number;
    activeMinutes: number;
    fixRuns: number;
    fixPrs: number;
  };
  repos: RepoRow[];
  recentReviews: ReviewRow[];
  recentRuns: RunRow[];
  connectors: { id: string; label: string; configured: boolean; ok?: boolean }[];
  automations: { name: string; kind: string; expr: string; enabled: boolean; lastRunAt?: string }[];
}

export interface ReviewDetailVM {
  review: ReviewRow;
  repo: string;
  headSha: string;
  status: string;
  risk: number;
  walkthrough: string; // markdown
  summary: string; // markdown
  llmUsed: boolean;
  similarFindings: { path: string; message: string; prNumber: number; when: string }[];
  learnings: string[];
  findings: {
    id: string;
    severity: string;
    category: string;
    source: string;
    path: string;
    line: number;
    message: string;
    suggestion?: string;
    confidence: number;
  }[];
}

export interface ConsoleThreadVM {
  id: string;
  channelKey: string;
  title?: string;
  updatedAt: string;
  messages: { role: string; author?: string; body: string; at: string }[];
}

export interface ConsoleVM {
  threads: { id: string; channelKey: string; title?: string; updatedAt: string; lastMessage: string }[];
}

export interface JobsVM {
  jobs: {
    id: string;
    type: string;
    status: string;
    attempts: number;
    runAt: string;
    lastError?: string;
    payload: string;
  }[];
}

export interface UsageVM {
  days: { day: string; runs: number; costUsd: number; minutes: number; promptTokens: number; completionTokens: number }[];
  byKind: { kind: string; runs: number; costUsd: number; minutes: number }[];
  topSteps: { name: string; kind: string; calls: number; costUsd: number; totalMs: number }[];
}

export interface RunDetailVM {
  run: RunRow;
  goal: string;
  steps: {
    seq: number;
    kind: string;
    name: string;
    ok: boolean;
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    detail: string; // JSON preview, truncated
  }[];
}
