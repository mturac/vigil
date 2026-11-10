// Vitest setup: environment for ALL test files (set before module imports).
process.env.DATABASE_URL = 'postgresql://vigil:vigil@localhost:5433/vigil';
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-1';
process.env.GITHUB_TOKEN = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.DASHBOARD_PASSWORD = '';
