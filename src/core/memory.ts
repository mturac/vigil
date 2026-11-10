// Team memory: durable knowledge items (facts, decisions, runbooks, preferences)
// scoped to team / channel / thread — the "living memory" layer.
import type { PrismaClient } from '@prisma/client';

export interface MemoryContext {
  repoFullName?: string; // e.g. "owner/name" → channel-scoped memory
  conversationId?: string; // thread memory
}

export class Memory {
  constructor(private db: PrismaClient, private opts: { enabled: boolean } = { enabled: true }) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private async repoIdFor(fullName?: string): Promise<string | undefined> {
    if (!fullName) return undefined;
    const [owner, name] = fullName.split('/');
    const repo = await this.db.repo.findFirst({ where: { owner, name } });
    return repo?.id;
  }

  async remember(input: {
    kind: 'fact' | 'decision' | 'runbook' | 'preference' | 'muted-rule';
    title: string;
    body: string;
    scope?: 'team' | 'channel' | 'thread';
    repoFullName?: string;
    conversationId?: string;
    sourceRunId?: string;
    pinned?: boolean;
  }): Promise<string> {
    if (!this.enabled) return '';
    const scope = input.scope ?? (input.conversationId ? 'thread' : input.repoFullName ? 'channel' : 'team');
    const scopeKey =
      scope === 'team' ? 'team:global'
      : scope === 'channel' ? `channel:${input.repoFullName ?? 'unknown'}`
      : `thread:${input.conversationId ?? 'unknown'}`;
    const repoId = await this.repoIdFor(input.repoFullName);
    const item = await this.db.knowledgeItem.create({
      data: {
        kind: input.kind,
        title: input.title.slice(0, 300),
        body: input.body,
        scope,
        scopeKey,
        ...(repoId ? { repoId } : {}),
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      },
    });
    return item.id;
  }

  /** Retrieve memory bullets relevant to a context (team + channel + thread). */
  async recall(ctx: MemoryContext, limit = 10): Promise<string[]> {
    if (!this.enabled) return [];
    const scopeKeys = ['team:global'];
    if (ctx.repoFullName) scopeKeys.push(`channel:${ctx.repoFullName}`);
    if (ctx.conversationId) scopeKeys.push(`thread:${ctx.conversationId}`);
    const items = await this.db.knowledgeItem.findMany({
      where: { scopeKey: { in: scopeKeys } },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });
    return items.map((i) => `- [${i.kind}] ${i.title}: ${i.body.slice(0, 400)}`);
  }

  async list(scopeKey?: string, limit = 50) {
    return this.db.knowledgeItem.findMany({
      ...(scopeKey ? { where: { scopeKey } } : {}),
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });
  }

  async forget(id: string): Promise<boolean> {
    const r = await this.db.knowledgeItem.deleteMany({ where: { id } });
    return r.count > 0;
  }

  async pin(id: string, pinned: boolean): Promise<void> {
    await this.db.knowledgeItem.update({ where: { id }, data: { pinned } });
  }
}
