// Governance: scopes gate access (users, repos, connectors) and daily spend.
import type { PrismaClient, Scope } from '@prisma/client';
import { globMatch } from './config.js';

export interface GovernanceDecision {
  allowed: boolean;
  reason?: string;
  scope?: Scope;
}

export class Governor {
  constructor(private db: PrismaClient) {}

  async resolveScope(opts?: { scopeName?: string; channelKey?: string }): Promise<Scope> {
    if (opts?.scopeName) {
      const byName = await this.db.scope.findUnique({ where: { name: opts.scopeName } });
      if (byName) return byName;
    }
    if (opts?.channelKey) {
      const channel = channelOfKey(opts.channelKey);
      if (channel) {
        const conv = await this.db.conversation.findUnique({ where: { channel_channelKey: { channel, channelKey: opts.channelKey } } });
        if (conv?.scopeId) {
          const byConv = await this.db.scope.findUnique({ where: { id: conv.scopeId } });
          if (byConv) return byConv;
        }
      }
    }
    const def = await this.db.scope.findFirst({ where: { isDefault: true } });
    if (def) return def;
    return this.db.scope.create({
      data: { name: 'default', allowedUsers: [], allowedRepos: ['*'], allowedConnectors: ['*'], spendLimitPerDayUsd: 5.0, isDefault: true },
    });
  }

  /** Check a user+repo+connector request against a scope. Empty allowlists = not enforced. */
  check(scope: Scope, req: { userId?: string; repo?: string; connector?: string }): GovernanceDecision {
    if (scope.allowedUsers.length > 0 && req.userId && !scope.allowedUsers.includes(req.userId)) {
      return { allowed: false, reason: `user "${req.userId}" is not in scope "${scope.name}" allowlist`, scope };
    }
    if (scope.allowedRepos.length > 0 && !scope.allowedRepos.includes('*') && req.repo && !scope.allowedRepos.some((p) => globMatch(p, req.repo as string))) {
      return { allowed: false, reason: `repo "${req.repo}" not allowed in scope "${scope.name}"`, scope };
    }
    if (
      scope.allowedConnectors.length > 0 &&
      !scope.allowedConnectors.includes('*') &&
      req.connector &&
      !scope.allowedConnectors.includes(req.connector)
    ) {
      return { allowed: false, reason: `connector "${req.connector}" not allowed in scope "${scope.name}"`, scope };
    }
    return { allowed: true, scope };
  }

  /** Daily spend check (UTC day). Throws when over budget. */
  async assertSpend(scope: Scope, extraCostUsd = 0): Promise<void> {
    const limit = scope.spendLimitPerDayUsd;
    if (limit === null || limit === undefined || limit <= 0) return; // unlimited when unset
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const agg = await this.db.run.aggregate({
      _sum: { costUsd: true },
      where: { scopeId: scope.id, createdAt: { gte: startOfDay }, status: { not: 'stopped' } },
    });
    const spent = agg._sum.costUsd ?? 0;
    if (spent + extraCostUsd > limit) {
      throw new Error(`governance: daily spend limit for scope "${scope.name}" exceeded ($${spent.toFixed(2)} spent + $${extraCostUsd.toFixed(2)} new > $${limit.toFixed(2)} limit)`);
    }
  }

  async usageToday(scopeId?: string): Promise<{ scopeName: string; spentUsd: number; limitUsd: number | null }> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const scopes = scopeId ? [await this.db.scope.findUnique({ where: { id: scopeId } })] : await this.db.scope.findMany();
    let total = 0;
    let name = 'all';
    let limit: number | null = null;
    for (const s of scopes) {
      if (!s) continue;
      const agg = await this.db.run.aggregate({ _sum: { costUsd: true }, where: { scopeId: s.id, createdAt: { gte: startOfDay } } });
      total += agg._sum.costUsd ?? 0;
      if (scopeId) { name = s.name; limit = s.spendLimitPerDayUsd; }
    }
    return { scopeName: name, spentUsd: total, limitUsd: limit };
  }
}

function channelOfKey(key: string): 'github' | 'slack' | 'console' | 'api' | null {
  if (key.startsWith('github:')) return 'github';
  if (key.startsWith('slack:')) return 'slack';
  if (key.startsWith('console:')) return 'console';
  if (key.startsWith('api:')) return 'api';
  return null;
}
