// Prisma client singleton + default scope bootstrap.
import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

// Vigil is PostgreSQL-only by design. Fail fast with a clear message instead of
// a cryptic Prisma error when DATABASE_URL points at anything else (e.g. a
// stray sqlite file: URL from the surrounding environment).
function assertPostgresUrl(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (url && !url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error(
      `DATABASE_URL must be a PostgreSQL connection string (postgresql://...); got "${url.slice(0, 40)}...". ` +
        'Vigil does not support sqlite or any other database. For local dev run: npm run db:boot',
    );
  }
}

const globalForPrisma = globalThis as unknown as { __vigilPrisma?: PrismaClient };

export const db: PrismaClient =
  globalForPrisma.__vigilPrisma ?? (assertPostgresUrl(), new PrismaClient({ log: process.env.DEBUG_PRISMA === '1' ? ['warn', 'error'] : ['error'] }));

if (process.env.NODE_ENV !== 'production') globalForPrisma.__vigilPrisma = db;

/** Ensure a default scope exists (governance baseline). Idempotent. */
export async function ensureDefaultScope(): Promise<string> {
  const existing = await db.scope.findFirst({ where: { isDefault: true } });
  if (existing) return existing.id;
  const created = await db.scope.create({
    data: {
      name: 'default',
      description: 'Base scope — created automatically on first boot',
      allowedUsers: [],
      allowedRepos: ['*'],
      allowedConnectors: ['*'],
      spendLimitPerDayUsd: 5.0,
      isDefault: true,
    },
  });
  logger.info({ scopeId: created.id }, 'created default governance scope');
  return created.id;
}
