/** Normalizes a Ukrainian license plate: uppercase, strip spaces/dashes, unify Cyrillic/Latin lookalikes. */
export function normalizePlate(plateRaw: string): string {
  const cyrillicToLatin: Record<string, string> = {
    А: "A", В: "B", С: "C", Е: "E", Н: "H", І: "I", Ї: "I", К: "K",
    М: "M", О: "O", Р: "P", Т: "T", Х: "X", У: "Y",
  };
  return plateRaw
    .toUpperCase()
    .replace(/[\s\-–—]/gu, "")
    .split("")
    .map((ch) => cyrillicToLatin[ch] ?? ch)
    .join("");
}

/** Builds a canonical url: lowercase host, strip query params and trailing slash. */
export function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = "";
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return rawUrl.trim();
  }
}

/** Loose text normalization for keyword matching. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
