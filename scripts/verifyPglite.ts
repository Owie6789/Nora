import { mkdirSync, rmSync } from 'fs';
import path from 'path';

import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

// Node's ESM resolver does not infer extensions, unlike Vite inside the app, so the `.ts` is
// required here and deliberately not required anywhere in `src/`.
import * as schema from '../src/main/db/schema.ts';

/**
 * Slice 0 verification. Proves the assumptions `sync/localStore.ts` will depend on, using plain
 * Node rather than vitest.
 *
 * Why not vitest: PGlite 0.5.8 cannot be instantiated inside this repo's vitest setup. Its
 * emscripten loader resolves `pglite.wasm` and `pglite.data` relative to `import.meta.url`, and
 * vitest's module pipeline does not preserve that, so every attempt fails with `TypeError: Cannot
 * read properties of undefined (reading 'pathname')` inside `loadPackage`, before a single query
 * runs. Confirmed to reproduce under all of: the default config, `ssr.external`, `pool: 'forks'`,
 * `isolate: false`, `server.deps.inline`, importing the package's ESM entry by absolute path, and
 * `createRequire`. PGlite itself is fine: it reports PostgreSQL 18.3 under plain Node. The
 * incompatibility is with the test runner, not the database.
 *
 * That has a direct architectural consequence. Database-touching tests cannot run in `npm test`, so
 * `sync/localStore.ts` must keep merge and normalisation logic in pure functions over explicit
 * state and stay a thin adapter over them. The alternative, a sync engine whose rules are only
 * reachable through a runner that cannot host the database, is worse.
 *
 * Run with: `node ./scripts/verifyPglite.ts` (exits non-zero on the first failure).
 *
 * Checks, in order:
 *
 * 1. PGlite starts and reports a PostgreSQL version
 * 2. Citext and pg_trgm register, which §6 bootstrap matching depends on
 * 3. The real migrations in resources/drizzle apply to a fresh database
 * 4. Those migrations created the four tables that receive syncIds
 * 5. Citext gives case-insensitive equality, which is what bootstrap matching relies on
 * 6. A failed transaction rolls back, so a partial apply cannot survive
 * 7. A successful transaction commits every statement
 * 8. Duplicate playlist names are permitted, which is why name cannot be identity
 */

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../resources/drizzle');

let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

async function createDatabase(dataDir: string) {
  const pg = await PGlite.create(dataDir, { extensions: { pg_trgm, citext } });
  await pg.exec('CREATE EXTENSION IF NOT EXISTS citext;');
  await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  const database = drizzle(pg, { schema });
  await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
  return { pg, database };
}

async function withDatabase<T>(
  fn: (ctx: { pg: PGlite; database: ReturnType<typeof drizzle> }) => Promise<T>
) {
  const dataDir = path.join(import.meta.dirname, '.pglite-verify', `${process.pid}-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  try {
    const ctx = await createDatabase(dataDir);
    try {
      return await fn(ctx);
    } finally {
      await ctx.pg.close();
    }
  } finally {
    // Best effort. PGlite can still hold a handle briefly after close(); a leftover directory is
    // harmless, a wrong assertion is not.
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log('PGlite verification\n');

await withDatabase(async ({ pg }) => {
  const result = await pg.query<{ version: string }>('SELECT version()');
  const version = result.rows[0]?.version ?? '';
  check(
    '1. PGlite starts and reports a version',
    version.includes('PostgreSQL'),
    version.slice(0, 48)
  );
});

await withDatabase(async ({ pg }) => {
  const result = await pg.query<{ extname: string }>(
    "SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm') ORDER BY extname"
  );
  const found = result.rows.map((row) => row.extname);
  check('2. citext and pg_trgm are registered', found.length === 2, found.join(', '));
});

await withDatabase(async ({ pg }) => {
  // Drizzle records applied migrations as ROWS in a single bookkeeping table, not as one table per
  // migration, so this counts rows rather than tables.
  const result = await pg.query<{ applied: number }>(
    'SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations'
  );
  const applied = result.rows[0]?.applied ?? 0;
  check(
    '3. all five real migrations applied',
    applied === 5,
    `${applied} of 5 migration rows recorded`
  );
});

await withDatabase(async ({ pg }) => {
  const result = await pg.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('playlists', 'artists', 'albums', 'genres')
      ORDER BY table_name`
  );
  const found = result.rows.map((row) => row.table_name);
  check('4. playlists, artists, albums and genres all exist', found.length === 4, found.join(', '));
});

await withDatabase(async ({ pg }) => {
  const result = await pg.query<{ matched: boolean }>(
    "SELECT 'The Weeknd'::citext = 'the weeknd'::citext AS matched"
  );
  check('5. citext compares case-insensitively', result.rows[0]?.matched === true);
});

await withDatabase(async ({ database }) => {
  await database.insert(schema.playlists).values({ name: 'Committed' });

  let threw = false;
  try {
    await database.transaction(async (trx) => {
      await trx.insert(schema.playlists).values({ name: 'Rolled back' });
      throw new Error('simulated failure mid-transaction');
    });
  } catch (error) {
    threw = error instanceof Error && error.message === 'simulated failure mid-transaction';
  }

  const survivors = await database.select().from(schema.playlists);
  const names = survivors.map((row) => row.name);
  check(
    '6. a failed transaction rolls back completely',
    threw && names.length === 1,
    names.join(', ')
  );
});

await withDatabase(async ({ database }) => {
  await database.transaction(async (trx) => {
    await trx.insert(schema.playlists).values({ name: 'First' });
    await trx.insert(schema.playlists).values({ name: 'Second' });
  });

  const survivors = await database.select().from(schema.playlists).orderBy(schema.playlists.name);
  const names = survivors.map((row) => row.name);
  check(
    '7. a successful transaction commits every statement',
    names.length === 2 && names[0] === 'First' && names[1] === 'Second',
    names.join(', ')
  );
});

await withDatabase(async ({ database }) => {
  await database.insert(schema.playlists).values({ name: 'Gym' });
  await database.insert(schema.playlists).values({ name: 'Gym' });

  const rows = await database.select().from(schema.playlists);
  const gymCount = rows.filter((row) => row.name === 'Gym').length;
  check(
    '8. duplicate playlist names are permitted, so name is not identity',
    gymCount === 2,
    `${gymCount} rows named "Gym"`
  );
});

console.log('');
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s) did not hold.`);
  process.exit(1);
}
console.log('All checks passed.');
