import type { ListingSource } from "./listing.js";

export const MARKETPLACE_CATEGORY_KEYS = [
  "vehicle.car",
  "electronics.laptop",
  "electronics.phone",
  "electronics.desktop",
  "electronics.component.gpu",
  "gaming.console",
  "transport.escooter",
  "generic",
] as const;

export type MarketplaceCategoryKey = (typeof MARKETPLACE_CATEGORY_KEYS)[number];
export type CategorySchemaVersion = 1;
export type UnknownFilterPolicy = "MAX_COVERAGE" | "STRICT";
export type TriStateFilterOutcome = "MATCH" | "NO_MATCH" | "UNKNOWN";

export type VehicleCarAttributes = {
  kind: "vehicle.car";
};

export type ComputerAttributes = {
  brand?: string;
  model?: string;
  cpu?: string;
  gpu?: string;
  ramGb?: number;
  storageGb?: number;
  storageType?: "SSD" | "HDD" | "EMMC" | "MIXED";
  screenInches?: number;
  refreshRateHz?: number;
  batteryHealthPercent?: number;
  riskKeywords?: string[];
};

export type PhoneAttributes = {
  brand?: string;
  model?: string;
  storageGb?: number;
  batteryHealthPercent?: number;
  sim?: string;
  riskKeywords?: string[];
};

export type GpuAttributes = {
  model?: string;
  vramGb?: number;
  riskKeywords?: string[];
};

export type ConsoleAttributes = {
  platform?: string;
  model?: string;
  storageGb?: number;
  accessories?: string[];
};

export type EscooterAttributes = {
  brand?: string;
  model?: string;
  powerW?: number;
  batteryWh?: number;
  rangeKm?: number;
  mileageKm?: number;
};

export type CategoryAttributesByKey = {
  "vehicle.car": VehicleCarAttributes;
  "electronics.laptop": ComputerAttributes;
  "electronics.phone": PhoneAttributes;
  "electronics.desktop": ComputerAttributes;
  "electronics.component.gpu": GpuAttributes;
  "gaming.console": ConsoleAttributes;
  "transport.escooter": EscooterAttributes;
  generic: Record<string, never>;
};

export type CategoryAttributes = CategoryAttributesByKey[MarketplaceCategoryKey];

export type CategoryFilterCriteria = {
  cpuIncludes?: string[];
  gpuIncludes?: string[];
  minRamGb?: number;
  minStorageGb?: number;
  minBatteryHealthPercent?: number;
  minVramGb?: number;
  minPowerW?: number;
  minRangeKm?: number;
  platformIncludes?: string[];
};

export type OlxCategoryDescriptor = {
  /** Internal feed category ID. Undefined means HTML-only until verified. */
  categoryId?: number;
  /** Fixed, registry-owned path. User input is never interpolated into origins. */
  path: string;
  /** Optional bounded server-side query for a broad parent category. */
  query?: string;
};

export type CategoryProfile = {
  key: MarketplaceCategoryKey;
  schemaVersion: CategorySchemaVersion;
  label: string;
  telegramLabel: string;
  supportedSources: readonly ListingSource[];
  olx?: OlxCategoryDescriptor;
};

const CAR_ONLY_SOURCES = ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO", "MOCK"] as const;
const OLX_AND_TEST = ["OLX", "MOCK"] as const;

export const CATEGORY_PROFILES: Record<MarketplaceCategoryKey, CategoryProfile> = {
  "vehicle.car": {
    key: "vehicle.car", schemaVersion: 1, label: "Автомобиль", telegramLabel: "АВТОМОБИЛЬ",
    supportedSources: CAR_ONLY_SOURCES,
    olx: { categoryId: 108, path: "/uk/transport/legkovye-avtomobili/" },
  },
  "electronics.laptop": {
    key: "electronics.laptop", schemaVersion: 1, label: "Ноутбук", telegramLabel: "НОУТБУК",
    supportedSources: OLX_AND_TEST,
    olx: { path: "/uk/elektronika/noutbuki-i-aksesuary/noutbuki/" },
  },
  "electronics.phone": {
    key: "electronics.phone", schemaVersion: 1, label: "Смартфон", telegramLabel: "СМАРТФОН",
    supportedSources: OLX_AND_TEST,
    olx: { path: "/uk/elektronika/telefony-i-aksesuary/mobilnye-telefony-smartfony/" },
  },
  "electronics.desktop": {
    key: "electronics.desktop", schemaVersion: 1, label: "Настольный компьютер", telegramLabel: "КОМПЬЮТЕР",
    supportedSources: OLX_AND_TEST,
    olx: { path: "/uk/elektronika/kompyutery-i-komplektuyuschie/nastolnye-kompyutery/" },
  },
  "electronics.component.gpu": {
    key: "electronics.component.gpu", schemaVersion: 1, label: "Видеокарта", telegramLabel: "ВИДЕОКАРТА",
    supportedSources: OLX_AND_TEST,
    olx: {
      path: "/uk/elektronika/kompyutery-i-komplektuyuschie/komplektuyuschie-i-aksesuary/",
      query: "відеокарта",
    },
  },
  "gaming.console": {
    key: "gaming.console", schemaVersion: 1, label: "Игровая консоль", telegramLabel: "КОНСОЛЬ",
    supportedSources: OLX_AND_TEST,
    olx: { path: "/uk/elektronika/igry-i-igrovye-pristavki/pristavki/" },
  },
  "transport.escooter": {
    key: "transport.escooter", schemaVersion: 1, label: "Электросамокат", telegramLabel: "ЭЛЕКТРОСАМОКАТ",
    supportedSources: OLX_AND_TEST,
    olx: { path: "/uk/transport/", query: "електросамокат" },
  },
  generic: {
    key: "generic", schemaVersion: 1, label: "Другое", telegramLabel: "ОБЪЯВЛЕНИЕ",
    supportedSources: OLX_AND_TEST,
    olx: { path: "/uk/", query: "" },
  },
};

export function isMarketplaceCategoryKey(value: unknown): value is MarketplaceCategoryKey {
  return typeof value === "string" && (MARKETPLACE_CATEGORY_KEYS as readonly string[]).includes(value);
}

export function marketplaceCategoryKey(value: unknown): MarketplaceCategoryKey {
  return isMarketplaceCategoryKey(value) ? value : "vehicle.car";
}

export function categoryProfile(value: unknown): CategoryProfile {
  return CATEGORY_PROFILES[marketplaceCategoryKey(value)];
}

export function sourceSupportsCategory(source: ListingSource, category: MarketplaceCategoryKey): boolean {
  return CATEGORY_PROFILES[category].supportedSources.includes(source);
}

export type CategoryValidationResult = {
  success: boolean;
  attributes: Record<string, string | number | string[]>;
  errors: string[];
};

/**
 * Fail-closed runtime validation for vertical JSON. Unknown properties are
 * stripped, malformed known properties are reported and never trusted.
 */
export function validateCategoryAttributes(
  category: MarketplaceCategoryKey,
  input: unknown,
): CategoryValidationResult {
  const source = isRecord(input) ? input : {};
  const result: Record<string, string | number | string[]> = {};
  const errors: string[] = input != null && !isRecord(input) ? ["attributes: expected object"] : [];
  const allow = allowedAttributeKinds(category);
  for (const [key, kind] of Object.entries(allow)) {
    const value = source[key];
    if (value == null) continue;
    if (key === "batteryHealthPercent" && typeof value === "number" && value > 100) {
      errors.push(`${key}: must be <= 100`);
      continue;
    }
    if (key === "storageType" && !["SSD", "HDD", "EMMC", "MIXED"].includes(String(value))) {
      errors.push(`${key}: invalid storage type`);
      continue;
    }
    if (kind === "string" && typeof value === "string" && value.trim()) result[key] = value.trim().slice(0, 240);
    else if (kind === "number" && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
    else if (kind === "strings" && Array.isArray(value) && value.every((item) => typeof item === "string")) {
      result[key] = [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 20);
    } else errors.push(`${key}: invalid ${kind}`);
  }
  return { success: errors.length === 0, attributes: result, errors };
}

export function validateCategoryFilterCriteria(input: unknown): { success: boolean; criteria: CategoryFilterCriteria; errors: string[] } {
  const source = isRecord(input) ? input : {};
  const criteria: CategoryFilterCriteria = {};
  const errors: string[] = [];
  const stringArrays = ["cpuIncludes", "gpuIncludes", "platformIncludes"] as const;
  const numbers = ["minRamGb", "minStorageGb", "minBatteryHealthPercent", "minVramGb", "minPowerW", "minRangeKm"] as const;
  for (const key of stringArrays) {
    const value = source[key];
    if (value == null) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) errors.push(`${key}: invalid string array`);
    else criteria[key] = [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 30);
  }
  for (const key of numbers) {
    const value = source[key];
    if (value == null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`${key}: invalid non-negative number`);
    else criteria[key] = value;
  }
  if ((criteria.minBatteryHealthPercent ?? 0) > 100) errors.push("minBatteryHealthPercent: must be <= 100");
  return { success: errors.length === 0, criteria, errors };
}

function allowedAttributeKinds(category: MarketplaceCategoryKey): Record<string, "string" | "number" | "strings"> {
  switch (category) {
    case "electronics.laptop":
    case "electronics.desktop":
      return { brand: "string", model: "string", cpu: "string", gpu: "string", ramGb: "number", storageGb: "number", storageType: "string", screenInches: "number", refreshRateHz: "number", batteryHealthPercent: "number", riskKeywords: "strings" };
    case "electronics.phone":
      return { brand: "string", model: "string", storageGb: "number", batteryHealthPercent: "number", sim: "string", riskKeywords: "strings" };
    case "electronics.component.gpu":
      return { model: "string", vramGb: "number", riskKeywords: "strings" };
    case "gaming.console":
      return { platform: "string", model: "string", storageGb: "number", accessories: "strings" };
    case "transport.escooter":
      return { brand: "string", model: "string", powerW: "number", batteryWh: "number", rangeKm: "number", mileageKm: "number" };
    case "vehicle.car":
    case "generic":
      return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
