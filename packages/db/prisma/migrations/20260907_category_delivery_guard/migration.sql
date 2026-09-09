ALTER TABLE "listings"
  ADD COLUMN "notificationMode" TEXT NOT NULL DEFAULT 'LIVE',
  ADD COLUMN "provisionalReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD CONSTRAINT "listings_notification_mode_check"
    CHECK ("notificationMode" IN ('LIVE', 'SHADOW'));

-- Recover the intent of pre-guard shadow matches. Already delivered messages
-- are historical facts; never rewrite their delivery state.
UPDATE "listings" AS l SET "notificationMode" = 'SHADOW'
WHERE EXISTS (
  SELECT 1 FROM "listing_matches" m JOIN "filters" f ON f.id = m."filterId"
  WHERE m."listingId" = l.id AND f."shadowMode" = TRUE
)
AND NOT EXISTS (
  SELECT 1 FROM "listing_matches" m JOIN "filters" f ON f.id = m."filterId"
  WHERE m."listingId" = l.id AND f."shadowMode" = FALSE
)
AND NOT EXISTS (
  SELECT 1 FROM "telegram_notifications" n
  WHERE n."listingId" = l.id AND n."messageId" IS NOT NULL
);
