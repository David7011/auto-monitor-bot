export const TELEGRAM_FAVORITE_CALLBACK_PREFIX = "amb:fav:";
// A retention claim normally lives only for the duration of one Telegram API
// request. While it is fresh, the favorite callback must not race the cleanup
// worker and promise to retain a message that is already being removed.
export const TELEGRAM_RETENTION_ACTIVE_CLAIM_MS = 5 * 60 * 1000;

export function telegramRetentionClaimIsActive(
  cleanupAttemptedAt: Date | null | undefined,
  now = new Date(),
): boolean {
  if (!cleanupAttemptedAt) return false;
  const ageMs = now.getTime() - cleanupAttemptedAt.getTime();
  return ageMs >= 0 && ageMs < TELEGRAM_RETENTION_ACTIVE_CLAIM_MS;
}

export type TelegramListingButton =
  | { text: string; url: string }
  | { text: string; callback_data: string };

export type TelegramListingKeyboard = {
  inline_keyboard: TelegramListingButton[][];
};

export function telegramFavoriteCallbackData(listingId: string): string {
  return `${TELEGRAM_FAVORITE_CALLBACK_PREFIX}${listingId}`;
}

export function telegramListingKeyboard(
  url: string,
  listingId: string,
  retainUntil: Date | string | null = null,
  favoriteRetentionDays = 10,
): TelegramListingKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Открыть объявление", url }],
      [
        {
          text: retainUntil
            ? `❤️ Сохранено на ${favoriteRetentionDays} дней`
            : `🤍 Сохранить на ${favoriteRetentionDays} дней`,
          callback_data: telegramFavoriteCallbackData(listingId),
        },
      ],
    ],
  };
}
