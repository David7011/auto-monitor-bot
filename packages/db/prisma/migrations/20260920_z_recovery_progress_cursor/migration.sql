ALTER TABLE "source_search_states"
  ADD COLUMN "recoveryProgressPage" INTEGER,
  ADD COLUMN "recoveryOverlapPage" INTEGER,
  ADD COLUMN "recoveryOverlapExternalIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "recoveryConsecutiveNoProgress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recoveryLastNoProgressReason" TEXT,
  ADD COLUMN "recoveryNextAttemptAt" TIMESTAMP(3);

ALTER TABLE "coverage_recovery_windows"
  ADD COLUMN "progressPage" INTEGER,
  ADD COLUMN "overlapPage" INTEGER,
  ADD COLUMN "overlapExternalIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "consecutiveNoProgress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastNoProgressReason" TEXT,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

-- Existing lastPage was an overlap-biased resume position. It is safe as the
-- first durable position: migration may repeat one page, but can never skip it.
UPDATE "source_search_states"
SET
  "recoveryProgressPage" = GREATEST(1, COALESCE("lastPage", 1)),
  "recoveryOverlapPage" = CASE
    WHEN "lastPage" IS NULL THEN NULL
    ELSE GREATEST(1, "lastPage" - 1)
  END
WHERE "coverageRecoveryPending" = TRUE;

UPDATE "coverage_recovery_windows" AS recovery
SET
  "progressPage" = state."recoveryProgressPage",
  "overlapPage" = state."recoveryOverlapPage"
FROM "source_search_states" AS state
WHERE recovery."sourceSearchStateId" = state.id
  AND recovery.status = 'PENDING';

ALTER TABLE "source_search_states"
  ADD CONSTRAINT "source_search_states_recovery_progress_positive"
  CHECK ("recoveryProgressPage" IS NULL OR "recoveryProgressPage" >= 1),
  ADD CONSTRAINT "source_search_states_recovery_overlap_positive"
  CHECK ("recoveryOverlapPage" IS NULL OR "recoveryOverlapPage" >= 1),
  ADD CONSTRAINT "source_search_states_recovery_no_progress_nonnegative"
  CHECK ("recoveryConsecutiveNoProgress" >= 0);

ALTER TABLE "coverage_recovery_windows"
  ADD CONSTRAINT "coverage_recovery_windows_progress_positive"
  CHECK ("progressPage" IS NULL OR "progressPage" >= 1),
  ADD CONSTRAINT "coverage_recovery_windows_overlap_positive"
  CHECK ("overlapPage" IS NULL OR "overlapPage" >= 1),
  ADD CONSTRAINT "coverage_recovery_windows_no_progress_nonnegative"
  CHECK ("consecutiveNoProgress" >= 0);

CREATE INDEX "source_search_states_recoveryNextAttemptAt_idx"
  ON "source_search_states"("recoveryNextAttemptAt");
