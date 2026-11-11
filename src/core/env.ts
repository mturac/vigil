// Load .env (if present) exactly once, before anything reads process.env.
// dotenv never overrides variables that are already set in the environment,
// so explicit exports always win — standard twelve-factor behavior.
import { config as loadDotenv } from 'dotenv';

const globalForEnv = globalThis as unknown as { __vigilEnvLoaded?: boolean };
if (!globalForEnv.__vigilEnvLoaded) {
  loadDotenv();
  globalForEnv.__vigilEnvLoaded = true;
}

export {};
