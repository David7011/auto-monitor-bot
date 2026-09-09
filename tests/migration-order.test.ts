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

  it("reopens OLX recovery windows that were falsely verified by an empty first page", () => {
    const sql = readFileSync(
      path.resolve("packages/db/prisma/migrations/20260902_reopen_unproven_olx_recovery/migration.sql"),
      "utf8",
    );
    expect(sql).toContain('"status" = \'PENDING\'::"CoverageRecoveryStatus"');
    expect(sql).toContain('recovery."verificationMethod" = \'EXHAUSTED\'::"CoverageVerificationMethod"');
    expect(sql).toContain('recovery."pageCount" <= 1');
    expect(sql).toContain('recovery."observedCount" = 0');
    expect(sql).toContain('"coverageRecoveryPending" = TRUE');
    expect(sql).toContain('"coverageAnchorExternalIds" = ARRAY[]::TEXT[]');
    expect(sql).toContain('"lastPage" = 1');
  });

  it("reconstructs recovery anchors only from observations persisted before the offline boundary", () => {
    const sql = readFileSync(
      path.resolve("packages/db/prisma/migrations/20260902_z_restore_olx_recovery_anchors/migration.sql"),
      "utf8",
    );
    expect(sql).toContain('recovery_window."status" = \'PENDING\'::"CoverageRecoveryStatus"');
    expect(sql).toContain('seen."firstSeenAt" <= pending."persistedBoundaryAt"');
    expect(sql).toContain('LIMIT 50');
    expect(sql).toContain('cardinality(state."coverageAnchorExternalIds") = 0');
  });

  it("reopens cutoff proofs that never durably reached the required boundary", () => {
    const sql = readFileSync(
      path.resolve("packages/db/prisma/migrations/20260903_reopen_unproven_cutoff_recovery/migration.sql"),
      "utf8",
    );
    expect(sql).toContain('recovery."verificationMethod" = \'CUTOFF\'::"CoverageVerificationMethod"');
    expect(sql).toContain('recovery."oldestObservedAt" > recovery."requiredCutoffAt"');
    expect(sql).toContain('"status" = \'PENDING\'::"CoverageRecoveryStatus"');
    expect(sql).toContain('seen."firstSeenAt" <= reopened."persistedBoundaryAt"');
    expect(sql).toContain('"lastPage" = 1');
  });

  it("keeps multi-category migration additive and constrains durable category state", () => {
    const foundation = readFileSync(
      path.resolve("packages/db/prisma/migrations/20260904_multi_category_marketplace/migration.sql"),
      "utf8",
    );
    const invariants = readFileSync(
      path.resolve("packages/db/prisma/migrations/20260904_z_multi_category_invariants/migration.sql"),
      "utf8",
    );
    expect(foundation).toContain('ADD COLUMN IF NOT EXISTS "categoryKey"');
    expect(foundation).not.toMatch(/DROP\s+(?:COLUMN|TABLE)/iu);
    expect(invariants).toContain('"source_search_states_parser_health_check"');
    expect(invariants).toContain("'electronics.laptop'");
    expect(invariants).toContain("'mixed'");
  });
});
