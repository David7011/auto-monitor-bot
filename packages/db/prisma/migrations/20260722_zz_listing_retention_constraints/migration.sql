ALTER TABLE "telegram_notifications"
  ADD CONSTRAINT "telegram_notifications_favorite_deadline_pair_check"
    CHECK (("favoritedAt" IS NULL) = ("retainUntil" IS NULL)),
  ADD CONSTRAINT "telegram_notifications_favorite_regular_deadline_check"
    CHECK ("favoritedAt" IS NULL OR "deleteAfter" IS NULL),
  ADD CONSTRAINT "telegram_notifications_applied_deadline_check"
    CHECK ("retentionPolicyAppliedAt" IS NULL OR "favoritedAt" IS NOT NULL OR "deleteAfter" IS NOT NULL);
