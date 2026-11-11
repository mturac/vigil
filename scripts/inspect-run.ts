import '../src/core/env.js';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const runs = await db.run.findMany({ orderBy: { createdAt: 'desc' }, take: 3, include: { steps: true } });
for (const r of runs) {
  console.log('RUN', r.id, r.kind, r.status, 'cost=' + r.costUsd.toFixed(4), 'steps=' + r.steps.length);
  for (const s of r.steps) {
    const d = typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail ?? '');
    console.log('  -', s.kind, s.name ?? '', String(d).slice(0, 110).replace(/\n/g, ' '));
  }
}
const f = await db.finding.count();
const rv = await db.review.count();
const fs2 = await db.finding.groupBy({ by: ['path'], _count: true });
console.log('DB totals: findings=' + f, 'reviews=' + rv, JSON.stringify(fs2));
await db.$disconnect();
