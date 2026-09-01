import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

describe("migration ordering", () => {
  it("declares every non-lexical dependency required by a fresh database", () => {
    const wrapper = readFileSync(
      path.resolve("packages/db/scripts/prisma-with-root-env.mjs"),
      "utf8",
    );

    expect(wrapper).toContain(
      `["20260710_hardening_baseline", "20260710_bff_generation_hardening"]`,
    );
    expect(wrapper).toContain(
      `["20260713_remove_telegram_channels_add_community_sources", "20260713_remove_community_sources"]`,
    );
    expect(wrapper).toContain(
      `["20260713_remove_community_sources", "20260713_add_automoto_source"]`,
    );
    expect(wrapper).toContain(
      `["20260713_add_automoto_source", "20260713_enable_automoto_for_existing_filters"]`,
    );
    expect(wrapper).toContain(
      `["20260830_telegram_flash_bundle", "20260830_listing_stage_timestamps"]`,
    );
    expect(wrapper).toContain("pg_advisory_lock");
    expect(wrapper).toContain("Refusing automatic baseline");
    expect(wrapper).toContain("Refusing bootstrap recovery");
  });

  it("leaves the recovery-aware OLX known-ID trigger as the final definition", () => {
    const root = path.resolve("packages/db/prisma/migrations");
    const definitions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        sql: readFileSync(path.join(root, entry.name, "migration.sql"), "utf8"),
      }))
      .filter((migration) => migration.sql.includes('reset_olx_known_ids_at_threshold'))
      .sort((left, right) => left.name.localeCompare(right.name));

    const finalDefinition = definitions.at(-1);
    expect(finalDefinition?.name).toMatch(/zz_olx_known_ids_recovery_guard$/u);
    expect(finalDefinition?.sql).toContain('"coverageAnchorExternalIds"');
    expect(finalDefinition?.sql).toContain('"coverageRecoveryPending" := TRUE');
    expect(finalDefinition?.sql).toContain('"coverageRecoveryCutoffAt"');
    expect(finalDefinition?.sql).toContain('"knownIdsResetAt" := NOW()');
    expect(finalDefinition?.sql).toContain('NEW."knownExternalIds" := ARRAY[]::TEXT[]');
  });

  it("commits the COVERAGE enum before reclassifying durable coverage history", () => {
    const root = path.resolve("packages/db/prisma/migrations");
    const enumMigration = "20260901_collector_run_semantics_enums";
    const dataMigration = "20260901_z_collector_run_semantics_data";
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    expect(names.indexOf(enumMigration)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(dataMigration)).toBeGreaterThan(names.indexOf(enumMigration));

    const enumSql = readFileSync(path.join(root, enumMigration, "migration.sql"), "utf8");
    const dataSql = readFileSync(path.join(root, dataMigration, "migration.sql"), "utf8");
    expect(enumSql).toContain(`ADD VALUE IF NOT EXISTS 'COVERAGE'`);
    expect(dataSql).toContain(`metric->>'kind' = 'olx-coverage-queue'`);
    expect(dataSql).toContain(`"lane" = 'COVERAGE'::"CollectorLane"`);
    expect(dataSql).toContain(`"trigger" = 'COVERAGE'::"CollectorRunTrigger"`);
  });

  it("persists auditable offline recovery windows after the search-state schema exists", () => {
    const sql = readFileSync(
      path.resolve("packages/db/prisma/migrations/20260901_zzz_offline_recovery_proof/migration.sql"),
      "utf8",
    );
    expect(sql).toContain('"persistedBoundaryAt" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain('"requiredCutoffAt" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain('"verifiedRunId" TEXT');
    expect(sql).toContain('"verificationMethod" "CoverageVerificationMethod"');
    expect(sql).toContain('REFERENCES "source_search_states"("id") ON DELETE CASCADE');
  });
});
