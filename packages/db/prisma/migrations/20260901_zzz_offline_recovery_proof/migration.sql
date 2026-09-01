CREATE TYPE "CoverageRecoveryReason" AS ENUM ('OFFLINE_WINDOW', 'REALTIME_OVERFLOW', 'KNOWN_IDS_RESET');
CREATE TYPE "CoverageRecoveryStatus" AS ENUM ('PENDING', 'VERIFIED');
CREATE TYPE "CoverageVerificationMethod" AS ENUM ('KNOWN_TAIL', 'CUTOFF', 'EXHAUSTED');

CREATE TABLE "coverage_recovery_windows" (
  "id" TEXT NOT NULL,
  "source" "ListingSource" NOT NULL,
  "sourceSearchStateId" TEXT NOT NULL,
  "reason" "CoverageRecoveryReason" NOT NULL,
  "status" "CoverageRecoveryStatus" NOT NULL DEFAULT 'PENDING',
  "persistedBoundaryAt" TIMESTAMP(3) NOT NULL,
  "requiredCutoffAt" TIMESTAMP(3) NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "latestSeenAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "lastAttemptRunId" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "verifiedRunId" TEXT,
  "verificationMethod" "CoverageVerificationMethod",
  "oldestObservedAt" TIMESTAMP(3),
  "pageCount" INTEGER NOT NULL DEFAULT 0,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "observedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "coverage_recovery_windows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coverage_recovery_windows_sourceSearchStateId_fkey"
    FOREIGN KEY ("sourceSearchStateId") REFERENCES "source_search_states"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "coverage_recovery_windows_sourceSearchStateId_persistedBoundaryAt_idx"
  ON "coverage_recovery_windows"("sourceSearchStateId", "persistedBoundaryAt");
CREATE INDEX "coverage_recovery_windows_source_status_detectedAt_idx"
  ON "coverage_recovery_windows"("source", "status", "detectedAt");
CREATE INDEX "coverage_recovery_windows_sourceSearchStateId_status_idx"
  ON "coverage_recovery_windows"("sourceSearchStateId", "status");
