import {
  BODY_TYPE_OPTIONS,
  DRIVE_TYPE_OPTIONS,
  FUEL_TYPE_OPTIONS,
  GEARBOX_OPTIONS,
  UKRAINE_CITIES_DATA_VERSION,
  UKRAINE_REGIONS,
  type VehicleAttributeOption,
} from "@amb/shared";
import { env } from "../env.js";

export type TaxonomyOption = {
  name: string;
  value: number;
};

type CacheEntry<T> = {
  complete: boolean;
  apiConfigured: boolean;
  source: "AUTO_RIA_API" | "LOCAL_FALLBACK";
  expiresAt: number;
  value: T;
};

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const requestCache = new Map<string, CacheEntry<TaxonomyOption[]>>();

const FALLBACK_MARKS: TaxonomyOption[] = [
  { name: "Audi", value: 6 },
  { name: "BMW", value: 9 },
  { name: "Chevrolet", value: 13 },
  { name: "Ford", value: 24 },
  { name: "Honda", value: 28 },
  { name: "Hyundai", value: 29 },
  { name: "Kia", value: 33 },
  { name: "Lexus", value: 37 },
  { name: "Mazda", value: 47 },
  { name: "Mercedes-Benz", value: 48 },
  { name: "Mitsubishi", value: 52 },
  { name: "Nissan", value: 55 },
  { name: "Opel", value: 56 },
  { name: "Peugeot", value: 58 },
  { name: "Renault", value: 62 },
  { name: "Skoda", value: 70 },
  { name: "Subaru", value: 75 },
  { name: "Tesla", value: 2233 },
  { name: "Toyota", value: 79 },
  { name: "Volkswagen", value: 84 },
  { name: "Volvo", value: 85 },
];

const FALLBACK_MODELS_BY_MARK = new Map<number, TaxonomyOption[]>([
  [6, options(["A3", "A4", "A5", "A6", "A7", "A8", "Q3", "Q5", "Q7", "Q8"])],
  [9, options(["1 Series", "2 Series", "3 Series", "4 Series", "5 Series", "7 Series", "X1", "X3", "X5", "X6"])],
  [24, options(["Fiesta", "Focus", "Fusion", "Kuga", "Mondeo", "Mustang", "S-Max"])],
  [28, options(["Accord", "Civic", "CR-V", "HR-V", "Pilot"])],
  [29, options(["Accent", "Elantra", "i30", "Santa FE", "Sonata", "Tucson"])],
  [33, options(["Ceed", "K5", "Optima", "Rio", "Sorento", "Sportage"])],
  [48, options(["A-Class", "B-Class", "C-Class", "E-Class", "GLA-Class", "GLC-Class", "GLE-Class", "S-Class"])],
  [56, options(["Astra", "Corsa", "Insignia", "Omega", "Vectra", "Zafira"])],
  [62, options(["Clio", "Duster", "Fluence", "Kangoo", "Laguna", "Megane", "Scenic"])],
  [70, options(["Fabia", "Kodiaq", "Octavia", "Rapid", "Superb", "Yeti"])],
  [79, options(["Auris", "Avensis", "Camry", "Corolla", "Land Cruiser", "Prius", "RAV4", "Yaris"])],
  [84, options(["Golf", "Jetta", "Passat", "Polo", "Tiguan", "Touareg", "Touran"])],
]);

export function vehicleAttributeGroups(): Record<string, VehicleAttributeOption[]> {
  return {
    bodyTypes: BODY_TYPE_OPTIONS,
    fuelTypes: FUEL_TYPE_OPTIONS,
    gearboxes: GEARBOX_OPTIONS,
    driveTypes: DRIVE_TYPE_OPTIONS,
  };
}

export function ukrainianRegions() {
  return {
    regions: UKRAINE_REGIONS,
    dataVersion: UKRAINE_CITIES_DATA_VERSION,
    cityCount: UKRAINE_REGIONS.reduce((sum, region) => sum + region.cities.length, 0),
  };
}

export async function getMarks(
  categoryId = 1,
): Promise<{ options: TaxonomyOption[]; complete: boolean; apiConfigured: boolean; source: "AUTO_RIA_API" | "LOCAL_FALLBACK" }> {
  return getCachedOptions(`marks:${categoryId}`, () => fetchAutoRiaOptions(`/categories/${categoryId}/marks`), FALLBACK_MARKS);
}

export async function getModels(
  categoryId: number,
  markId: number,
): Promise<{ options: TaxonomyOption[]; complete: boolean; apiConfigured: boolean; source: "AUTO_RIA_API" | "LOCAL_FALLBACK" }> {
  return getCachedOptions(
    `models:${categoryId}:${markId}`,
    () => fetchAutoRiaOptions(`/categories/${categoryId}/marks/${markId}/models`),
    FALLBACK_MODELS_BY_MARK.get(markId) ?? [],
  );
}

async function getCachedOptions(
  key: string,
  loader: () => Promise<TaxonomyOption[]>,
  fallback: TaxonomyOption[],
): Promise<{ options: TaxonomyOption[]; complete: boolean; apiConfigured: boolean; source: "AUTO_RIA_API" | "LOCAL_FALLBACK" }> {
  const cached = requestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { options: cached.value, complete: cached.complete, apiConfigured: cached.apiConfigured, source: cached.source };
  }

  if (!env.AUTO_RIA_API_KEY) {
    const normalizedFallback = normalizeOptions(fallback);
    requestCache.set(key, {
      complete: false,
      apiConfigured: false,
      source: "LOCAL_FALLBACK",
      value: normalizedFallback,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { options: normalizedFallback, complete: false, apiConfigured: false, source: "LOCAL_FALLBACK" };
  }

  try {
    const loaded = normalizeOptions(await loader());
    requestCache.set(key, {
      complete: true,
      apiConfigured: true,
      source: "AUTO_RIA_API",
      value: loaded,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { options: loaded, complete: true, apiConfigured: true, source: "AUTO_RIA_API" };
  } catch {
    const normalizedFallback = normalizeOptions(fallback);
    requestCache.set(key, {
      complete: false,
      apiConfigured: true,
      source: "LOCAL_FALLBACK",
      value: normalizedFallback,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    return { options: normalizedFallback, complete: false, apiConfigured: true, source: "LOCAL_FALLBACK" };
  }
}

async function fetchAutoRiaOptions(pathname: string): Promise<TaxonomyOption[]> {
  const urls = autoRiaUrls(pathname);
  let lastError: Error | undefined;

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) {
        lastError = new Error(`AUTO.RIA taxonomy failed: HTTP ${response.status}`);
        continue;
      }

      const json = (await response.json()) as unknown;
      if (Array.isArray(json)) return json as TaxonomyOption[];
      if (json && typeof json === "object" && Array.isArray((json as { value?: unknown }).value)) {
        return (json as { value: TaxonomyOption[] }).value;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("AUTO.RIA taxonomy unavailable");
}

function autoRiaUrls(pathname: string): string[] {
  if (!env.AUTO_RIA_API_KEY) return [];
  return [`https://developers.ria.com/auto${pathname}?api_key=${encodeURIComponent(env.AUTO_RIA_API_KEY)}`];
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "auto-monitor-bot/0.2",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOptions(items: TaxonomyOption[]): TaxonomyOption[] {
  const seen = new Set<number>();
  return items
    .filter((item) => typeof item.name === "string" && Number.isInteger(item.value))
    .map((item) => ({ name: item.name.trim(), value: item.value }))
    .filter((item) => {
      if (!item.name || seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
}

function options(names: string[]): TaxonomyOption[] {
  return names.map((name, index) => ({ name, value: index + 1 }));
}
