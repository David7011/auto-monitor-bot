export function isTransientNavigationError(error) {
  return error instanceof Error && /Execution context was destroyed|Cannot find context with specified id/.test(error.message);
}

export async function readRstCards(page) {
  try {
    return await page.locator('article[id^="i-"]').evaluateAll(cards => {
      // Check origin in the same document as the extracted cards, not before navigation.
      if (location.origin !== 'https://rst.ua' || location.pathname !== '/ukr/oldcars/') return [];
      return cards.map(card => ({
        id: card.id.replace(/^i-/, ''),
        title: card.querySelector('a.ai')?.textContent?.trim() ?? '',
        href: card.querySelector('a.ai')?.getAttribute('href') ?? '',
      })).filter(card => /^\d+$/.test(card.id) && card.title && card.href);
    });
  } catch (error) {
    if (isTransientNavigationError(error)) return [];
    throw error;
  }
}
