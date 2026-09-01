-- Align legacy hand-written DDL with the current Prisma datamodel. This is
-- intentionally a new migration: already-applied historical files keep their
-- original checksums.
ALTER TABLE "dashboard_users"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER INDEX "source_seen_listings_source_firstObservedChannel_firstSeenAt_id"
  RENAME TO "source_seen_listings_source_firstObservedChannel_firstSeenA_idx";
