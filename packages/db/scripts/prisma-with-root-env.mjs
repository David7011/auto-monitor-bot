import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "../../..");
const envPath = path.join(rootDir, ".env");
const migrationsDir = path.join(rootDir, "packages/db/prisma/migrations");
const BASELINE_MIGRATION = "20260710_hardening_baseline";
const BOOTSTRAP_MARKER_TABLE = "_amb_migration_bootstrap";
const BOOTSTRAP_LOCK_ID = 7_610_202_607_100;
const MIGRATION_ORDER_CONSTRAINTS = [
  ["20260710_hardening_baseline", "20260710_bff_generation_hardening"],
  ["20260713_remove_telegram_channels_add_community_sources", "20260713_remove_community_sources"],
  ["20260713_remove_community_sources", "20260713_add_automoto_source"],
  ["20260713_add_automoto_source", "20260713_enable_automoto_for_existing_filters"],
  ["20260830_telegram_flash_bundle", "20260830_listing_stage_timestamps"],
];
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquote(trimmed.slice(separatorIndex + 1));
    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function runPrisma(args) {
  return spawnSync(process.execPath, [prismaCli, ...args], {
    stdio: "inherit",
  });
}

function successful(result) {
  return result.status === 0;
}

async function prepareFreshDatabaseForDeploy() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;

  const migrations = orderedMigrations();
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "amb-migration-bootstrap",
  });

  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [BOOTSTRAP_LOCK_ID]);

  try {
    const state = await readBootstrapState(client);
    if (state.hasMigrationHistory && !state.hasBootstrapMarker) return;

    if (!state.hasBootstrapMarker && state.publicTableCount > 0) {
      throw new Error(
        "Refusing automatic baseline: the database has public tables but no Prisma migration history.",
      );
    }

    console.log(
      state.hasBootstrapMarker
        ? "[db] Resuming interrupted fresh-database bootstrap"
        : `[db] Empty database detected; applying ${migrations.length} migrations in dependency-safe order`,
    );
    await bootstrapMigrations(client, migrations, state.hasBootstrapMarker);
    await client.query(`DROP TABLE public."${BOOTSTRAP_MARKER_TABLE}"`);
    console.log("[db] Fresh-database migration bootstrap completed");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [BOOTSTRAP_LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

function orderedMigrations() {
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const filePath = path.join(migrationsDir, entry.name, "migration.sql");
      const file = readFileSync(filePath, "utf8");
      return {
        name: entry.name,
        sql: stripOuterTransaction(file.replace(/^\uFEFF/u, "")),
        checksum: createHash("sha256").update(file).digest("hex"),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const migrationByName = new Map(migrations.map((migration) => [migration.name, migration]));
  const dependencies = new Map(migrations.map((migration) => [migration.name, new Set()]));
  const dependents = new Map(migrations.map((migration) => [migration.name, new Set()]));
  for (const [prerequisite, dependent] of MIGRATION_ORDER_CONSTRAINTS) {
    if (!migrationByName.has(prerequisite) || !migrationByName.has(dependent)) {
      throw new Error(`Migration ordering constraint references a missing migration: ${prerequisite} -> ${dependent}`);
    }
    dependencies.get(dependent).add(prerequisite);
    dependents.get(prerequisite).add(dependent);
  }

  const ordered = [];
  const ready = migrations.filter((migration) => dependencies.get(migration.name).size === 0);
  while (ready.length > 0) {
    ready.sort((left, right) => left.name.localeCompare(right.name));
    const migration = ready.shift();
    ordered.push(migration);
    for (const dependent of dependents.get(migration.name)) {
      const remaining = dependencies.get(dependent);
      remaining.delete(migration.name);
      if (remaining.size === 0) ready.push(migrationByName.get(dependent));
    }
  }
  if (ordered.length !== migrations.length) {
    throw new Error("Fresh database migration ordering constraints contain a cycle.");
  }

  if (ordered[0]?.name !== BASELINE_MIGRATION) {
    throw new Error(`Fresh database baseline must be first: ${BASELINE_MIGRATION}`);
  }
  return ordered;
}

function stripOuterTransaction(sql) {
  const trimmed = sql.trim();
  if (!/^BEGIN\s*;/iu.test(trimmed) || !/COMMIT\s*;\s*$/iu.test(trimmed)) return sql;
  return trimmed.replace(/^BEGIN\s*;/iu, "").replace(/COMMIT\s*;\s*$/iu, "");
}

async function bootstrapMigrations(client, migrations, hasBootstrapMarker) {
  if (!hasBootstrapMarker) {
    await client.query("BEGIN");
    try {
      await client.query(`
        CREATE TABLE public."${BOOTSTRAP_MARKER_TABLE}" (
          "migration" TEXT PRIMARY KEY,
          "checksum" TEXT NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(migrations[0].sql);
      await client.query(
        `INSERT INTO public."${BOOTSTRAP_MARKER_TABLE}" ("migration", "checksum") VALUES ($1, $2)`,
        [migrations[0].name, migrations[0].checksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  const markerResult = await client.query(
    `SELECT "migration", "checksum" FROM public."${BOOTSTRAP_MARKER_TABLE}" LIMIT 1`,
  );
  const marker = markerResult.rows[0];
  const markerIndex = migrations.findIndex(
    (migration) => migration.name === marker?.migration && migration.checksum === marker?.checksum,
  );
  if (markerIndex < 0) {
    throw new Error("Refusing bootstrap recovery: marker does not match the repository migration history.");
  }

  await ensureMigrationResolved(client, migrations[markerIndex].name);

  for (const migration of migrations.slice(markerIndex + 1)) {
    if (await migrationIsApplied(client, migration.name)) continue;
    console.log(`[db] Applying fresh-database migration ${migration.name}`);
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query(`DELETE FROM public."${BOOTSTRAP_MARKER_TABLE}"`);
      await client.query(
        `INSERT INTO public."${BOOTSTRAP_MARKER_TABLE}" ("migration", "checksum") VALUES ($1, $2)`,
        [migration.name, migration.checksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await ensureMigrationResolved(client, migration.name);
  }
}

async function ensureMigrationResolved(client, migrationName) {
  if (await migrationIsApplied(client, migrationName)) return;
  const result = runPrisma(["migrate", "resolve", "--applied", migrationName]);
  if (!successful(result)) throw new Error(`Could not register migration ${migrationName}`);
}

async function migrationIsApplied(client, migrationName) {
  if ((await client.query("SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present")).rows[0]
    ?.present !== true) {
    return false;
  }
  const result = await client.query(
    `SELECT 1 FROM public."_prisma_migrations"
     WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL
     LIMIT 1`,
    [migrationName],
  );
  return result.rowCount === 1;
}

async function readBootstrapState(client) {
  const result = await client.query(
    `
      SELECT
        to_regclass('public._prisma_migrations') IS NOT NULL AS "hasMigrationHistory",
        to_regclass('public.${BOOTSTRAP_MARKER_TABLE}') IS NOT NULL AS "hasBootstrapMarker",
        (
          SELECT COUNT(*)::INTEGER
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
            AND table_name NOT IN ('_prisma_migrations', '${BOOTSTRAP_MARKER_TABLE}')
        ) AS "publicTableCount"
    `,
  );
  return result.rows[0];
}

const prismaArgs = process.argv.slice(2);
if (prismaArgs[0] === "migrate" && prismaArgs[1] === "deploy") {
  try {
    await prepareFreshDatabaseForDeploy();
  } catch (error) {
    console.error(`[db] Fresh database bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const result = runPrisma(prismaArgs);

process.exit(result.status ?? 1);
