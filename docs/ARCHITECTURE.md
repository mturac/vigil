# Architecture

```
                    ┌────────────────────────────────────────────────┐
                    │                 Surfaces                       │
                    │  Slack events · GitHub webhook · Console (web) │
                    │  CLI (review/fix/ask/scan/skill/…)             │
                    └───────────────┬────────────────────────────────┘
                                    │ express (src/server.ts)
                                    │ HMAC-verified webhooks, dashboard, JSON APIs
                    ┌───────────────▼────────────────────────────────┐
                    │              Queue (PostgreSQL)                │
                    │  SKIP LOCKED claiming, retries w/ backoff,     │
                    │  dedupe keys (head SHA, comment id, cron slot) │
                    └───────────────┬────────────────────────────────┘
                                    │ job types: review.pr · fix.issue ·
                                    │ chat.slack · chat.github_comment ·
                                    │ automation.run · automation.pr_summary
        ┌───────────────────────────┼──────────────────────────────┐
        ▼                           ▼                              ▼
┌───────────────┐          ┌────────────────┐            ┌──────────────────┐
│ ReviewEngine  │          │   ChatAgent    │            │    Daemon        │
│ heuristics(29)│◄─────────│  LLM tool loop │            │ cron automations │
│ + LLM layer   │          │  (max 14 steps)│            │ + GitHub poller  │
│ report + post │          └───────┬────────┘            └──────────────────┘
└───────┬───────┘                  │ tools
        │                   ┌──────▼──────────────────────────────┐
        │                   │ connectors · review/fix · memory ·   │
        │                   │ skills (standup/debug/postmortem/…)  │
        │                   └──────┬──────────────────────────────┘
        ▼                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         FixEngine                                    │
│ clone → branch → agent patch loop (read/list/write/apply_patch/run/  │
│ finish) → sandbox verify (allowlist/deny/timeout/docker) → commit →  │
│ push → open PR → auto-learn memory                                   │
└──────────────────────────────────────────────────────────────────────┘
        │                                   │
        ▼                                   ▼
┌────────────────────────── PostgreSQL ────────────────────────────────┐
│ Job · Run · RunStep · Review · Finding · Pull · Repo · FixRun ·      │
│ Conversation · ChatMessage · KnowledgeItem · Automation · Scope      │
└──────────────────────────────────────────────────────────────────────┘
```

## Modules

- `src/analysis/` — dependency-free core: unified-diff parser with PR-side line
  numbers, 29-rule heuristic engine, report builders (review report, walkthrough
  with mermaid file graph, standup, postmortem).
- `src/core/` — config (`.vigil.yml` + env, glob matching), LLM layer
  (OpenAI-compatible / Anthropic / mock, cost table), durable queue, governance
  (scopes, spend), memory (team/channel/thread knowledge), sandbox
  (local allowlist or Docker, deny patterns, timeouts).
- `src/review/` — the review pipeline: fetch PR → repo config → heuristics →
  LLM layer → merge → similar findings → memory → persist → post (inline
  comments + REQUEST_CHANGES with own-PR fallback).
- `src/fix/` — autonomous fix pipeline with fuzzy unified-diff applier
  (offset-tolerant hunk matching) and verification-gated push.
- `src/chat/` — agent loop + skills.
- `src/connectors/` — one file per vendor + MCP client + registry.
- `src/dashboard/` — pure view-model → HTML rendering (no client framework).
- `src/server.ts`, `src/daemon.ts`, `src/index.ts` — HTTP, runtime, CLI.

## Data model highlights

- **Run/RunStep**: every LLM call and tool call with tokens, USD cost, duration —
  the "explainable, attributed" guarantee.
- **Finding**: severity, confidence, rule id, source (heuristic/llm/heuristic+llm), snippet —
  powers similar-findings lookback and muting.
- **Anchoring guarantee** (`src/analysis/anchor.ts`): LLM findings are never
  trusted blindly. Each one must anchor to an actually-added diff line whose
  content corroborates it; hallucinated line numbers are re-anchored by
  content similarity or the finding is dropped. LLM findings that corroborate
  a deterministic rule fold into it (`heuristic+llm`) instead of duplicating
  it. Regression tests reproduce a real incident where the same finding came
  back on lines 7/5/8 across three runs.
- **KnowledgeItem**: scope (`team|channel|thread`) + scopeKey — the living memory.
- **Scope**: user/repo/connector allowlists + daily USD spend limit.
- **Job**: dedupeKey unique — webhook replay and cron double-fire are idempotent.
- **Review idempotency**: a head SHA that was already reviewed & posted is
  skipped on re-run (`--force` overrides) — no duplicate reviews.

## Design decisions

- **PostgreSQL only** (user requirement): queue, memory, audit — everything is
  relational, no sqlite anywhere. Dev/CI ships embedded PostgreSQL 18 binaries.
- **Bring your own model**: OpenAI-compatible base URL covers OpenAI, Ollama,
  vLLM, OpenRouter, DeepSeek, Groq, LM Studio; native Anthropic support; a
  deterministic mock provider makes the whole agent loop testable offline.
- **Heuristics never depend on the LLM**: reviews work with zero credentials;
  the LLM is an additive layer, so results are reproducible and auditable.
- **Sandboxed verification**: fixes only push when the repo's verify command
  exits 0 inside the sandbox; every command runs against an allowlist and deny
  patterns with hard timeouts.
- **Server-rendered dashboard**: zero client JS dependencies beyond a tiny
  inline script for the console — fast, auditable, no supply chain.
