// Dev database bootstrapper: embedded PostgreSQL (real PG 18 binaries) for local
// runs and CI. Production uses any managed/self-hosted PostgreSQL via DATABASE_URL.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DATA_DIR = process.env.VIGIL_PGDATA ?? 'pgdata';
const PORT = parseInt(process.env.VIGIL_PG_PORT ?? '5433', 10);
const USER = 'vigil';
const PASSWORD = 'vigil';
const DB = 'vigil';

function databaseUrl(): string {
  const raw = process.env.DATABASE_URL ?? '';
  // Only accept PostgreSQL URLs — stray file:/sqlite URLs from the surrounding
  // environment must never leak into this Postgres-only product.
  if (raw.startsWith('postgres://') || raw.startsWith('postgresql://')) return raw;
  return `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB}`;
}

async function main(): Promise<void> {
  const fresh = !existsSync(`${DATA_DIR}/PG_VERSION`);
  const pg = new EmbeddedPostgres({
    database_dir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    onLog: (msg: string) => process.env.VIGIL_PG_LOG === '1' && console.log('[pg]', msg),
  });
  if (fresh) {
    console.log(`bootstrapping embedded postgres in ${DATA_DIR} (port ${PORT})...`);
    await pg.initialise();
    console.log('initialised.');
  }
  await pg.start();
  console.log(`postgres running on :${PORT}`);
  try {
    await pg.createDatabase(DB);
    console.log(`database "${DB}" created`);
  } catch {
    console.log(`database "${DB}" already exists`);
  }

  if (existsSync('prisma/migrations')) {
    try {
      execSync('npx prisma migrate deploy', {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: databaseUrl() },
      });
      console.log('migrations applied');
    } catch (e) {
      console.error('migrate deploy failed:', (e as Error).message);
      console.error('set DATABASE_URL=' + databaseUrl() + ' and run: npx prisma migrate deploy');
    }
  }

  if (process.argv.includes('--daemon')) {
    console.log(`DATABASE_URL=${databaseUrl()}`);
    console.log('staying alive (ctrl+c to stop)');
    await new Promise(() => {});
  } else {
    console.log('postgres stopped (data kept in ' + DATA_DIR + ')');
    console.log(`next start: DATABASE_URL=${databaseUrl()}`);
    await pg.stop();
  }
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
