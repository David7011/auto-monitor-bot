ALTER TABLE "source_seen_listings"
  ADD COLUMN "originQueuedAt" TIMESTAMP(3),
  ADD COLUMN "originAdmittedAt" TIMESTAMP(3),
  ADD COLUMN "firstRequestId" TEXT,
  ADD COLUMN "bodyDecodedAt" TIMESTAMP(3);
