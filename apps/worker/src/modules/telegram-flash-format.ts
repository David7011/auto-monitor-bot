import type { TelegramListingSnapshot } from "./telegram-listing-format.js";

export const TELEGRAM_FLASH_RENDERED_TEXT_LIMIT = 3_900;

export function telegramFlashBundleText(
  listings: readonly Pick<
    TelegramListingSnapshot,
    "source" | "url" | "title" | "brand" | "model" | "year" | "priceNormalized" | "priceOriginal" | "currencyOriginal" | "city"
  >[],
): string {
  const lines = [
    `⚡ <b>FLASH: ${listings.length} свежих объявлений</b>`,
    "Все ссылки уже здесь. Подробные карточки идут следом:",
    "",
  ];
  for (const [index, listing] of listings.entries()) {
    const title = compactTitle(listing);
    const suffix = [compactPrice(listing), listing.city].filter(Boolean).join(" · ");
    lines.push(
      `<a href="${escapeHtmlAttribute(listing.url)}">${index + 1}. ${escapeHtmlText(title)}</a>${suffix ? ` · ${escapeHtmlText(suffix)}` : ""}`,
    );
  }
  const text = lines.join("\n");
  if (renderedTextLength(text) > TELEGRAM_FLASH_RENDERED_TEXT_LIMIT) {
    throw new Error(`Telegram flash bundle exceeds ${TELEGRAM_FLASH_RENDERED_TEXT_LIMIT} rendered characters`);
  }
  return text;
}

function compactTitle(listing: Pick<TelegramListingSnapshot, "source" | "title" | "brand" | "model" | "year">): string {
  const value = listing.title?.trim()
    || [listing.brand, listing.model, listing.year].filter(Boolean).join(" ")
    || `${listing.source} объявление`;
  return value.length <= 90 ? value : `${value.slice(0, 87)}…`;
}

function compactPrice(
  listing: Pick<TelegramListingSnapshot, "priceNormalized" | "priceOriginal" | "currencyOriginal">,
): string | null {
  if (listing.priceNormalized != null) return `${listing.priceNormalized} $`;
  if (listing.priceOriginal != null) return `${listing.priceOriginal} ${listing.currencyOriginal ?? ""}`.trim();
  return null;
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/gu, "&quot;");
}

function renderedTextLength(value: string): number {
  return value
    .replace(/<a href="[^"]*">/gu, "")
    .replace(/<\/(?:a|b)>/gu, "")
    .replace(/<b>/gu, "")
    .replace(/&(?:amp|lt|gt|quot);/gu, "x")
    .length;
}
