import { canonicalizeUrl, type NormalizedListing } from "@amb/shared";
import type { CollectorResult, SourceCollector, SourceSearchContext, SourceSearchState } from "./base.js";

const BRANDS: Array<{ brand: string; models: string[] }> = [
  { brand: "BMW", models: ["3 Series", "5 Series", "X5"] },
  { brand: "Audi", models: ["A4", "A6", "Q5"] },
  { brand: "Toyota", models: ["Camry", "Corolla", "RAV4"] },
  { brand: "Volkswagen", models: ["Passat", "Golf", "Tiguan"] },
  { brand: "Mercedes-Benz", models: ["C-Class", "E-Class", "GLC"] },
];

const CITIES: Array<{ city: string; region: string }> = [
  { city: "Київ", region: "Київська область" },
  { city: "Львів", region: "Львівська область" },
  { city: "Одеса", region: "Одеська область" },
  { city: "Харків", region: "Харківська область" },
  { city: "Дніпро", region: "Дніпропетровська область" },
];

const KEYWORD_POOL = ["автомат", "механіка", "дизель", "бензин", "повний привід", "один власник"];

function randomOf<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * MockCollector emits 0-2 random listings per run so the whole pipeline
 * (filters, duplicate guard, telegram, background check) can be tested
 * without real site access.
 */
export class MockCollector implements SourceCollector {
  readonly source = "MOCK" as const;
  readonly supportsNewestFirst = true;
  readonly newestFirstVerified = true;

  async collect(_context: SourceSearchContext, state: SourceSearchState): Promise<CollectorResult> {
    const count = randomInt(0, 2);
    const listings: NormalizedListing[] = [];
    const now = new Date();

    for (let i = 0; i < count; i++) {
      const externalId = `mock-${now.getTime()}-${randomInt(1000, 9999)}`;
      if (state.knownExternalIds.has(externalId)) continue;

      const { brand, models } = randomOf(BRANDS);
      const model = randomOf(models);
      const year = randomInt(2010, 2024);
      const price = randomInt(4000, 45000);
      const location = randomOf(CITIES);
      const keywords = [randomOf(KEYWORD_POOL), randomOf(KEYWORD_POOL)];
      const url = `https://example.com/mock/${externalId}`;

      listings.push({
        source: "MOCK",
        externalId,
        url,
        canonicalUrl: canonicalizeUrl(url),
        title: `${brand} ${model} ${year}`,
        brand,
        model,
        year,
        priceOriginal: price,
        currencyOriginal: "USD",
        priceNormalized: price,
        mileage: randomInt(10, 320) * 1000,
        city: location.city,
        region: location.region,
        description: `${brand} ${model} ${year}, ${keywords.join(", ")}. Тестове оголошення mock-джерела.`,
        photoUrls: [],
        publishedAt: now,
        timestampConfidence: "HIGH",
        firstSeenAt: now,
        raw: { mock: true },
      });
    }

    return { listings };
  }
}
