-- PostgreSQL cannot use a newly-added enum value until the transaction which
-- adds it has committed. Keep this enum expansion in its own migration; the
-- following migration performs the column/data changes.
ALTER TYPE "CollectorLane" ADD VALUE IF NOT EXISTS 'COVERAGE' AFTER 'BACKFILL';

CREATE TYPE "CollectorRunTrigger" AS ENUM (
  'SCHEDULED',
  'MANUAL',
  'BACKFILL',
  'RECOVERY',
  'COVERAGE'
);
