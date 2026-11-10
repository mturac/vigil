// Structured logging via pino.
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({ level, base: null });

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
