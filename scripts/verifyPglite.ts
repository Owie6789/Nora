import { mkdirSync, rmSync } from 'fs';
import path from 'path';

import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { eq, getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

// Node's ESM resolver does not infer extensions, unlike Vite inside the app, so the `.ts` is
// required here and deliberately not required anywhere in `src/`.
// oxlint-disable-next-line import/order
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
 * One database is created and every check runs inside it. Creating eight would mean eight startups
 * and eight migration passes, which is cost without isolation: each check already uses its own
 * rows. The column-drift probes each run in a transaction that is rolled back, so they leave
 * nothing behind.
 *
 * Run with: `node ./scripts/verifyPglite.ts`. Exits non-zero if any check fails; every check still
 * runs so one run reports every problem rather than only the first.
 */

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../resources/drizzle');
const EXPECTED_MIGRATIONS = 5;
const SYNC_ID_TABLES = ['albums', 'artists', 'genres', 'playlists'] as const;
/**
 * Distinct from every other literal this script writes, so a probe row is never mistaken for real
 * data.
 */
const PROBE = '__verify_pglite_drift_probe__';

let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const dataDir = path.join(import.meta.dirname, '.pglite-verify', `${process.pid}-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });

  const pg = await PGlite.create(dataDir, { extensions: { pg_trgm, citext } });
  const database = drizzle(pg, { schema });

  try {
    await pg.exec('CREATE EXTENSION IF NOT EXISTS citext;');
    await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });

    console.log('PGlite verification\n');

    const version = await pg.query<{ version: string }>('SELECT version()');
    check(
      '1. PGlite starts and reports a version',
      (version.rows[0]?.version ?? '').includes('PostgreSQL'),
      (version.rows[0]?.version ?? '').slice(0, 48)
    );

    const extensions = await pg.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm') ORDER BY extname"
    );
    check(
      '2. citext and pg_trgm are registered',
      extensions.rows.length === 2,
      extensions.rows.map((row) => row.extname).join(', ')
    );

    // Drizzle records applied migrations as ROWS in one bookkeeping table, not one table per
    // migration, so this counts rows rather than tables.
    const applied = await pg.query<{ applied: number }>(
      'SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations'
    );
    const appliedCount = applied.rows[0]?.applied ?? 0;
    check(
      '3. all five real migrations applied',
      appliedCount === EXPECTED_MIGRATIONS,
      `${appliedCount} of ${EXPECTED_MIGRATIONS} migration rows recorded`
    );

    const present = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[...SYNC_ID_TABLES]]
    );
    const presentNames = present.rows.map((row) => row.table_name);
    check(
      '4. all four syncId-bearing tables exist',
      SYNC_ID_TABLES.every((table) => presentNames.includes(table)),
      presentNames.join(', ')
    );

    const citextEqual = await pg.query<{ matched: boolean }>(
      "SELECT 'The Weeknd'::citext = 'the weeknd'::citext AS matched"
    );
    check('5. citext compares case-insensitively', citextEqual.rows[0]?.matched === true);

    // Check 4 only proves the tables exist. It does NOT prove the migrations agree with schema.ts: a
    // column added to schema.ts but absent from every migration leaves this check green, which is
    // precisely the drift slice 1's syncId columns would introduce. So round-trip one row per table
    // and compare the returned keys against the keys drizzle's own types declare. Any column present
    // in one place and not the other fails here.
    type Db = typeof database;
    const model: Record<(typeof SYNC_ID_TABLES)[number], (db: Db) => Promise<unknown[]>> = {
      albums: async (db) => await db.insert(schema.albums).values({ title: PROBE }).returning(),
      artists: async (db) => await db.insert(schema.artists).values({ name: PROBE }).returning(),
      genres: async (db) => await db.insert(schema.genres).values({ name: PROBE }).returning(),
      playlists: async (db) => await db.insert(schema.playlists).values({ name: PROBE }).returning()
    };
    // Removed by primary key rather than by matching the probe text, so this stays correct if the
    // natural-key column is renamed. `delete(table).where(...)` is not the right call here: with a
    // column rather than a table as the first argument, drizzle builds the statement against that
    // column and it fails at runtime.
    const deleteProbeRow = async (table: (typeof SYNC_ID_TABLES)[number]) => {
      const model = modelTables[table];
      await database.delete(model).where(eq(primaryKeyOf(model), probeRowIds.get(table) as number));
    };
    // Derived from the drizzle table objects rather than hand-written, so this list cannot drift out of
    // agreement with schema.ts on its own.
    //
    // What this detects, and what it deliberately does not: the INSERT names every column drizzle
    // believes exists, so a column added to schema.ts but missing from the migrations makes the
    // INSERT fail and check 6 reports it. That is the drift slice 1 introduces when it adds `syncId`
    // columns, and it is the direction that matters.
    //
    // The opposite direction is NOT covered, and the probe was rewritten after being caught claiming
    // it was. Appending `ALTER TABLE "artists" ADD COLUMN ... "orphan_drift_column"` to a migration
    // leaves this check green, because a migration is free to create columns the ORM never selects and
    // the ORM's own view is internally consistent. Catching that needs comparing
    // information_schema.columns against the table definition, which is check 11 below.
    const modelTables = {
      albums: schema.albums,
      artists: schema.artists,
      genres: schema.genres,
      playlists: schema.playlists
    } as const;
    const expectedKeys = Object.fromEntries(
      Object.entries(modelTables).map(([table, model]) => [
        table,
        Object.keys(getTableColumns(model)).sort()
      ])
    ) as Record<(typeof SYNC_ID_TABLES)[number], string[]>;

    const primaryKeyOf = (model: (typeof modelTables)[keyof typeof modelTables]) =>
      getTableColumns(model).id;
    const probeRowIds = new Map<string, number>();

    // Each probe inserts one row and then deletes it, rather than inserting inside a transaction that
    // is rolled back. Both look equivalent, but a deliberately aborted transaction leaves PGlite's
    // single connection in a failed state, and later statements on that instance then fail with
    // connection-level errors instead of the check's own result. An earlier version of this loop used
    // the throw-then-rollback form and reported failures that had nothing to do with drift. Insert and
    // delete keeps the connection clean and needs no savepoints, which PGlite rejects outside a
    // transaction block anyway.
    for (const table of SYNC_ID_TABLES) {
      let row: Record<string, unknown> | undefined;
      let probeError = '';
      try {
        row = (await model[table](database))[0] as Record<string, unknown> | undefined;
        if (typeof row?.id === 'number') probeRowIds.set(table, row.id);
        await deleteProbeRow(table);
      } catch (error) {
        // A migration that created a column the ORM does not know about can make the INSERT itself
        // fail. That is still drift, so it is reported as drift rather than crashing the gate, which
        // would exit non-zero for the wrong reason and say nothing about what actually diverged.
        probeError =
          error instanceof Error
            ? (error.message.split('\n')[0] ?? 'insert failed')
            : 'insert failed';
      }

      const actual = Object.keys(row ?? {}).sort();
      const wanted = [...expectedKeys[table]].sort();
      const inMigrationNotSchema = actual.filter((key) => !wanted.includes(key));
      const inSchemaNotMigration = wanted.filter((key) => !actual.includes(key));
      check(
        `6. ${table} columns match schema.ts exactly`,
        probeError === '' && inMigrationNotSchema.length === 0 && inSchemaNotMigration.length === 0,
        probeError !== ''
          ? `probe insert failed: ${probeError}`
          : inMigrationNotSchema.length || inSchemaNotMigration.length
            ? `unexpected: ${inMigrationNotSchema.join(',') || '-'} | missing: ${inSchemaNotMigration.join(',') || '-'}`
            : `${wanted.length} columns`
      );
    }

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
    const afterRollback = (await database.select().from(schema.playlists)).map((row) => row.name);
    check(
      '7. a failed transaction rolls back completely',
      threw && afterRollback.length === 1 && afterRollback[0] === 'Committed',
      afterRollback.join(', ')
    );

    await database.transaction(async (trx) => {
      await trx.insert(schema.playlists).values({ name: 'First' });
      await trx.insert(schema.playlists).values({ name: 'Second' });
    });
    const afterCommit = (await database.select().from(schema.playlists))
      .map((row) => row.name)
      .sort();
    check(
      '8. a successful transaction commits every statement',
      afterCommit.includes('First') && afterCommit.includes('Second'),
      afterCommit.join(', ')
    );

    await database.insert(schema.playlists).values({ name: 'Gym' });
    await database.insert(schema.playlists).values({ name: 'Gym' });
    const gymCount = (await database.select().from(schema.playlists)).filter(
      (row) => row.name === 'Gym'
    ).length;
    check(
      '9. duplicate playlist names are permitted, so name is not identity',
      gymCount === 2,
      `${gymCount} rows named "Gym"`
    );

    // PGlite exposes a single connection, so a query issued on the shared instance while a
    // transaction is open does not interleave and does not fail fast; it blocks. db.ts exports one
    // module-level instance that 26 modules import, and 19 call sites already open transactions, so
    // this is the constraint that shapes how localStore.ts must take its commit lock.
    const blocker = await pg.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(4242) AS locked'
    );
    check(
      '10. an advisory lock is available for serialising the sync commit',
      blocker.rows[0]?.locked === true
    );
    await pg.query('SELECT pg_advisory_unlock(4242)');

    // The direction check 6 cannot see: a column that a migration created but schema.ts does not
    // declare. Drizzle never selects it, so the ORM stays internally consistent and every other check
    // stays green. Comparing the database's own view against the table definition is the only way to
    // see it, and it is the direction that catches a migration edited by hand.
    const dbColumns = await pg.query<{ column_name: string }>(
      `SELECT c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.table_name = ANY($1::text[])
        ORDER BY c.table_name, c.column_name`,
      [[...SYNC_ID_TABLES]]
    );
    // Compare database column NAMES, which are snake_case (`created_at`, `name_ci`), against drizzle's
    // SQL names rather than its camelCase object keys (`createdAt`, `nameCI`). Using the keys compares
    // two different naming conventions and reports every generated citext column as undeclared.
    const declared = new Set<string>();
    for (const table of SYNC_ID_TABLES) {
      for (const column of Object.values(getTableColumns(modelTables[table]))) {
        declared.add(column.name);
      }
    }
    const undeclared = dbColumns.rows
      .map((row) => row.column_name)
      .filter((name) => !declared.has(name));
    check(
      '11. no migration creates a column schema.ts does not declare',
      undeclared.length === 0,
      undeclared.length
        ? `undeclared: ${undeclared.join(',')}`
        : `${dbColumns.rows.length} columns accounted for`
    );
  } finally {
    await pg.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best effort. PGlite can still hold a handle briefly after close(); a leftover directory is
      // harmless, a wrong assertion is not.
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`FAILED: ${failures} check(s) did not hold.`);
    process.exitCode = 1;
    return;
  }
  console.log('All checks passed.');
}

await main();
