import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { loadConfig } from '@gerald/config';

const config = loadConfig();
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const START_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000] as const;

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function railwayPostgresOptions(): ConstructorOptions | undefined {
  const host = process.env.PGHOST?.trim();
  if (!host) return undefined;

  const options: ConstructorOptions = { host };
  const port = Number(process.env.PGPORT);
  if (Number.isInteger(port) && port > 0) options.port = port;
  if (process.env.PGDATABASE) options.database = process.env.PGDATABASE;
  if (process.env.PGUSER) options.user = process.env.PGUSER;
  if (process.env.PGPASSWORD) options.password = process.env.PGPASSWORD;
  if (process.env.PGSSLMODE === 'require') options.ssl = { rejectUnauthorized: false };
  return options;
}

function resolveDatabaseConnection():
  { connection: string | ConstructorOptions; host: string } | undefined {
  const railwayOptions = railwayPostgresOptions();
  if (config.databaseUrl) {
    const configuredHost = new URL(config.databaseUrl).hostname;
    if (
      railwayOptions?.host &&
      isLoopbackHost(configuredHost) &&
      !isLoopbackHost(railwayOptions.host)
    ) {
      return { connection: railwayOptions, host: railwayOptions.host };
    }
    return { connection: config.databaseUrl, host: configuredHost };
  }
  if (railwayOptions?.host) return { connection: railwayOptions, host: railwayOptions.host };
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function startBoss(connection: string | ConstructorOptions, host: string): Promise<PgBoss> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= START_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    const boss = typeof connection === 'string' ? new PgBoss(connection) : new PgBoss(connection);
    boss.on('error', (error: unknown) => {
      console.error(
        JSON.stringify({
          worker: 'gerald',
          state: 'database_error',
          host,
          error: errorMessage(error),
        }),
      );
    });
    try {
      await boss.start();
      return boss;
    } catch (error) {
      lastError = error;
      await boss.stop().catch(() => undefined);
      const delay = START_RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) break;
      console.error(
        `Gerald worker could not connect to PostgreSQL at ${host}; retrying in ${delay}ms (attempt ${attempt}/${START_RETRY_DELAYS_MS.length + 1}).`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const database = resolveDatabaseConnection();
if (!database) {
  console.log('Gerald worker is ready in local mode; DATABASE_URL is not configured.');
} else {
  const boss = await startBoss(database.connection, database.host);
  await boss.createQueue('gerald.outbox');
  await boss.work('gerald.outbox', async (jobs: Array<{ id: string; data: unknown }>) => {
    for (const job of jobs)
      console.log(
        JSON.stringify({ worker: 'gerald', jobId: job.id, state: 'received', payload: job.data }),
      );
  });
  console.log('Gerald worker started.');
}
