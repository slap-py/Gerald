import { PgBoss } from 'pg-boss';
import { loadConfig } from '@gerald/config';

const config = loadConfig();
if (!config.databaseUrl) {
  console.log('Gerald worker is ready in local mode; DATABASE_URL is not configured.');
} else {
  const boss = new PgBoss({ connectionString: config.databaseUrl });
  await boss.start();
  await boss.createQueue('gerald.outbox');
  await boss.work('gerald.outbox', async (jobs: Array<{ id: string; data: unknown }>) => {
    for (const job of jobs)
      console.log(
        JSON.stringify({ worker: 'gerald', jobId: job.id, state: 'received', payload: job.data }),
      );
  });
  console.log('Gerald worker started.');
}
