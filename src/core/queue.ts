// Postgres-backed durable job queue with SKIP LOCKED claiming + dedupe.
import type { PrismaClient } from '@prisma/client';

export interface JobHandler {
  type: string;
  handle(payload: Record<string, unknown>): Promise<void>;
}

export class Queue {
  private handlers = new Map<string, JobHandler>();
  private workerId = `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private polling: NodeJS.Timeout | null = null;
  private stopped = false;
  private busy = false;

  constructor(private db: PrismaClient, private opts: { pollMs?: number; batchSize?: number; logger?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void } } = {}) {}

  register(handler: JobHandler): void {
    this.handlers.set(handler.type, handler);
  }

  async enqueue(type: string, payload: Record<string, unknown>, opts?: { runAt?: Date; dedupeKey?: string }): Promise<string | null> {
    try {
      const job = await this.db.job.create({
        data: { type, payload: payload as object, ...(opts?.runAt ? { runAt: opts.runAt } : {}), ...(opts?.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}) },
      });
      return job.id;
    } catch {
      // dedupe conflict (P2002 on dedupeKey) — treat as already enqueued
      return null;
    }
  }

  start(): void {
    if (this.polling) return;
    this.stopped = false;
    const pollMs = this.opts.pollMs ?? 1500;
    this.polling = setInterval(() => void this.tick(), pollMs);
    this.polling.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.polling) clearInterval(this.polling);
    this.polling = null;
  }

  private async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const batch = await this.db.$queryRaw<{ id: string; type: string; payload: object; attempts: number; maxAttempts: number }[]>`
        UPDATE "Job" SET "lockedAt" = now(), "lockedBy" = ${this.workerId}, "status" = 'running', "attempts" = "attempts" + 1, "updatedAt" = now()
        WHERE id IN (
          SELECT id FROM "Job"
          WHERE status = 'pending' AND "runAt" <= now()
          ORDER BY "runAt" ASC
          LIMIT ${this.opts.batchSize ?? 3}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, payload, attempts, "maxAttempts"`;
      for (const job of batch) {
        await this.runJob(job.id, job.type, job.payload as Record<string, unknown>, job.attempts, job.maxAttempts);
      }
    } catch (e) {
      this.opts.logger?.error({ err: (e as Error).message }, 'queue tick failed');
    } finally {
      this.busy = false;
    }
  }

  private async runJob(id: string, type: string, payload: Record<string, unknown>, attempts: number, maxAttempts: number): Promise<void> {
    const handler = this.handlers.get(type);
    if (!handler) {
      await this.db.job.update({ where: { id }, data: { status: 'failed', lastError: `no handler for type "${type}"`, lockedAt: null, lockedBy: null } }).catch(() => {});
      return;
    }
    try {
      await handler.handle(payload);
      await this.db.job.update({ where: { id }, data: { status: 'done', lockedAt: null, lockedBy: null, lastError: null } }).catch(() => {});
    } catch (e) {
      const message = (e as Error).message.slice(0, 2000);
      const retry = attempts < maxAttempts;
      await this.db.job
        .update({
          where: { id },
          data: { status: retry ? 'pending' : 'failed', lastError: message, lockedAt: null, lockedBy: null, ...(retry ? { runAt: new Date(Date.now() + Math.min(60000, 2 ** attempts * 1000)) } : {}) },
        })
        .catch(() => {});
      this.opts.logger?.error({ jobId: id, type, retry, err: message }, 'job failed');
    }
  }
}
