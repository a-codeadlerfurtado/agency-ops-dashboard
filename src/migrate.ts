import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from './config.js';

const { Client } = pg;
const url = env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL ausente');
if (!env.IMOBI_APP_PASSWORD) throw new Error('IMOBI_APP_PASSWORD ausente');

const db = new Client({ connectionString: url });
await db.connect();

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureAppRole() {
  const exists = await db.query(`SELECT 1 FROM pg_roles WHERE rolname='imobi_app'`);
  if (!exists.rows[0]) {
    await db.query(`CREATE ROLE imobi_app LOGIN PASSWORD ${literal(env.IMOBI_APP_PASSWORD!)}`);
  } else {
    await db.query(`ALTER ROLE imobi_app LOGIN PASSWORD ${literal(env.IMOBI_APP_PASSWORD!)}`);
  }
  await db.query(`ALTER ROLE imobi_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
}

async function grants() {
  await db.query(`GRANT CONNECT ON DATABASE imobia TO imobi_app`);
  await db.query(`GRANT USAGE ON SCHEMA public TO imobi_app`);
  await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO imobi_app`);
  await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO imobi_app`);
  await db.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO imobi_app`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO imobi_app`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO imobi_app`);
}
try {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  await ensureAppRole();
  const dir = resolve(process.cwd(), 'db');
  const files = (await readdir(dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const done = await db.query(`SELECT 1 FROM schema_migrations WHERE name=$1`, [file]);
    if (done.rows[0]) { console.log(`skip ${file}`); continue; }
    console.log(`apply ${file}`);
    const sql = await readFile(resolve(dir, file), 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query(`INSERT INTO schema_migrations(name) VALUES ($1)`, [file]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  }
  await grants();
  console.log('migrations ok');
} finally {
  await db.end();
}
