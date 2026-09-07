import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createDatabase } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for migrations');
const { pool } = createDatabase(databaseUrl);
const migration = await readFile(new URL('../drizzle/0000_init.sql', import.meta.url), 'utf8');
await pool.query(migration);
await pool.end();
