import {
  extractVinFromText,
  normalizePlate,
} from "@amb/shared";
import { sourceHttpClient } from "../collectors/source-http-client.js";
import { env } from "../env.js";

export type VehicleLookupListing = {
  brand: string | null;
  model: string | null;
  year: number | null;
  engineVolume: number | null;
  fuelType: string | null;
};

type VpicResponse = {
  Results?: Array<Record<string, string | null | undefined>>;
};

type NhtsaRecallsResponse = {
  Count?: number;
  results?: Array<{
    NHTSACampaignNumber?: string;
    Component?: string;
  }>;
};

type NhtsaComplaintsResponse = {
  Count?: number;
  results?: unknown[];
};

type NhtsaSafetyResponse = {
  Results?: Array<{
    VehicleId?: number | string;
    VehicleDescription?: string;
    OverallRating?: string;
    OverallFrontCrashRating?: string;
    OverallSideCrashRating?: string;
    RolloverRating?: string;
  }>;
};

export type RecallLookup = {
  checked: boolean;
  count: number;
  campaigns: string[];
  raw: object | null;
};

export type ComplaintsLookup = {
  checked: boolean;
  count: number;
  raw: object | null;
};

export type SafetyLookup = {
  checked: boolean;
  overallRating: string | null;
  vehicleDescription: string | null;
  raw: object | null;
};

type DataGovUaStolenRow = {
  id?: string | null;
  brand?: string | null;
  color?: string | null;
  number?: string | null;
  body_number?: string | null;
  chassis_number?: string | null;
  engine_number?: string | null;
  ovd?: string | null;
  kind?: string | null;
  status?: string | null;
  theft_date?: string | null;
  insert_date?: string | null;
};

export type StolenLookup = {
  checked: boolean;
  found: boolean;
  matches: DataGovUaStolenRow[];
  raw: object | null;
};

type StolenIndex = {
  byPlate: Map<string, DataGovUaStolenRow[]>;
  byVin: Map<string, DataGovUaStolenRow[]>;
  loadedAt: string;
  rows: number;
};

export type DecodedVin = {
  make: string | null;
  model: string | null;
  year: number | null;
  engineVolume: number | null;
  fuelType: string | null;
  bodyType: string | null;
  driveType: string | null;
  errorCode: string | null;
  errorText: string | null;
  raw: Record<string, string | null>;
};

let stolenIndexCache: { expiresAt: number; index: StolenIndex } | null = null;
let stolenIndexPromise: Promise<StolenIndex | null> | null = null;

export async function decodeVinWithNhtsa(
  vin: string,
  year: number | null,
): Promise<{ decoded: DecodedVin | null; raw: object }> {
  const url = new URL(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}`);
  url.searchParams.set("format", "json");
  if (year) url.searchParams.set("modelyear", String(year));

  const response = await sourceHttpClient.json<VpicResponse>(url.toString(), {
    source: "NHTSA_VPIC",
    timeoutMs: env.NHTSA_VPIC_TIMEOUT_MS,
  });
  if (response.classification !== "SUCCESS" || !response.data?.Results?.[0]) {
    return {
      decoded: null,
      raw: {
        classification: response.classification,
        status: response.status,
        requestId: response.requestId,
        errorMessage: response.errorMessage,
      },
    };
  }

  const row = response.data.Results[0];
  const jsonRow = jsonRecord(row);
  return {
    decoded: {
      make: cleanString(row.Make),
      model: cleanString(row.Model),
      year: parseInteger(row.ModelYear),
      engineVolume: parseNumber(row.DisplacementL),
      fuelType: cleanString(row.FuelTypePrimary),
      bodyType: cleanString(row.BodyClass),
      driveType: cleanString(row.DriveType),
      errorCode: cleanString(row.ErrorCode),
      errorText: cleanString(row.ErrorText),
      raw: jsonRow,
    },
    raw: {
      classification: response.classification,
      status: response.status,
      requestId: response.requestId,
      decoded: jsonRow,
    },
  };
}

export async function lookupNhtsaRecalls(
  listing: VehicleLookupListing,
  decoded: DecodedVin | null,
): Promise<RecallLookup> {
  const make = decoded?.make ?? listing.brand;
  const model = decoded?.model ?? listing.model;
  const year = decoded?.year ?? listing.year;
  if (!env.NHTSA_RECALLS_ENABLED || !make || !model || !year) {
    return { checked: false, count: 0, campaigns: [], raw: null };
  }

  const url = new URL("https://api.nhtsa.gov/recalls/recallsByVehicle");
  url.searchParams.set("make", make);
  url.searchParams.set("model", model);
  url.searchParams.set("modelYear", String(year));
  const response = await sourceHttpClient.json<NhtsaRecallsResponse>(url.toString(), {
    source: "NHTSA_RECALLS",
    timeoutMs: env.NHTSA_RECALLS_TIMEOUT_MS,
  });
  if (response.classification !== "SUCCESS" || !response.data) {
    return {
      checked: true,
      count: 0,
      campaigns: [],
      raw: {
        classification: response.classification,
        status: response.status,
        requestId: response.requestId,
        errorMessage: response.errorMessage,
      },
    };
  }

  const campaigns = (response.data.results ?? [])
    .map((item) => [item.NHTSACampaignNumber, item.Component].filter(Boolean).join(": "))
    .filter(Boolean)
    .slice(0, 5);
  return {
    checked: true,
    count: Number(response.data.Count ?? response.data.results?.length ?? 0),
    campaigns,
    raw: {
      classification: response.classification,
      status: response.status,
      requestId: response.requestId,
      count: response.data.Count ?? response.data.results?.length ?? 0,
      campaigns,
    },
  };
}

export async function lookupNhtsaComplaints(
  listing: VehicleLookupListing,
  decoded: DecodedVin | null,
): Promise<ComplaintsLookup> {
  const make = decoded?.make ?? listing.brand;
  const model = decoded?.model ?? listing.model;
  const year = decoded?.year ?? listing.year;
  if (!env.NHTSA_COMPLAINTS_ENABLED || !make || !model || !year) {
    return { checked: false, count: 0, raw: null };
  }

  const url = new URL("https://api.nhtsa.gov/complaints/complaintsByVehicle");
  url.searchParams.set("make", make);
  url.searchParams.set("model", model);
  url.searchParams.set("modelYear", String(year));
  const response = await sourceHttpClient.json<NhtsaComplaintsResponse>(url.toString(), {
    source: "NHTSA_COMPLAINTS",
    timeoutMs: env.NHTSA_COMPLAINTS_TIMEOUT_MS,
  });
  const count = response.classification === "SUCCESS" && response.data
    ? Number(response.data.Count ?? response.data.results?.length ?? 0)
    : 0;
  return {
    checked: true,
    count,
    raw: {
      classification: response.classification,
      status: response.status,
      requestId: response.requestId,
      count,
      errorMessage: response.errorMessage,
    },
  };
}

export async function lookupNhtsaSafety(
  listing: VehicleLookupListing,
  decoded: DecodedVin | null,
): Promise<SafetyLookup> {
  const make = decoded?.make ?? listing.brand;
  const model = decoded?.model ?? listing.model;
  const year = decoded?.year ?? listing.year;
  if (!env.NHTSA_SAFETY_RATINGS_ENABLED || !make || !model || !year) {
    return { checked: false, overallRating: null, vehicleDescription: null, raw: null };
  }

  const variantsUrl = `https://api.nhtsa.gov/SafetyRatings/modelyear/${year}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}?format=json`;
  const variants = await sourceHttpClient.json<NhtsaSafetyResponse>(variantsUrl, {
    source: "NHTSA_SAFETY_VARIANTS",
    timeoutMs: env.NHTSA_SAFETY_RATINGS_TIMEOUT_MS,
  });
  const variant = variants.classification === "SUCCESS" ? variants.data?.Results?.[0] : undefined;
  if (!variant?.VehicleId) {
    return {
      checked: true,
      overallRating: null,
      vehicleDescription: null,
      raw: {
        classification: variants.classification,
        status: variants.status,
        requestId: variants.requestId,
        variants: variants.data?.Results?.length ?? 0,
        errorMessage: variants.errorMessage,
      },
    };
  }

  const ratingUrl = `https://api.nhtsa.gov/SafetyRatings/VehicleId/${encodeURIComponent(String(variant.VehicleId))}?format=json`;
  const rating = await sourceHttpClient.json<NhtsaSafetyResponse>(ratingUrl, {
    source: "NHTSA_SAFETY_RATING",
    timeoutMs: env.NHTSA_SAFETY_RATINGS_TIMEOUT_MS,
  });
  const item = rating.classification === "SUCCESS" ? rating.data?.Results?.[0] : undefined;
  return {
    checked: true,
    overallRating: cleanRating(item?.OverallRating),
    vehicleDescription: cleanString(item?.VehicleDescription ?? variant.VehicleDescription),
    raw: {
      classification: rating.classification,
      status: rating.status,
      requestId: rating.requestId,
      vehicleId: variant.VehicleId,
      vehicleDescription: item?.VehicleDescription ?? variant.VehicleDescription ?? null,
      overallRating: item?.OverallRating ?? null,
      frontCrashRating: item?.OverallFrontCrashRating ?? null,
      sideCrashRating: item?.OverallSideCrashRating ?? null,
      rolloverRating: item?.RolloverRating ?? null,
      errorMessage: rating.errorMessage,
    },
  };
}

export async function lookupDataGovUaStolen(
  plateNormalized: string | null,
  vin: string | null,
): Promise<StolenLookup> {
  if (!env.DATA_GOV_UA_STOLEN_ENABLED || (!plateNormalized && !vin)) {
    return { checked: false, found: false, matches: [], raw: null };
  }

  const index = await loadStolenIndex();
  if (!index) {
    return { checked: true, found: false, matches: [], raw: { error: "stolen_index_unavailable" } };
  }
  const matches = [
    ...(plateNormalized ? index.byPlate.get(plateNormalized) ?? [] : []),
    ...(vin ? index.byVin.get(vin.toUpperCase()) ?? [] : []),
  ];
  const uniqueMatches = uniqueStolenRows(matches).slice(0, 5);
  return {
    checked: true,
    found: uniqueMatches.length > 0,
    matches: uniqueMatches,
    raw: {
      source: "data.gov.ua CarsWanted",
      loadedAt: index.loadedAt,
      rows: index.rows,
      matched: uniqueMatches.map((item) => ({
        id: item.id,
        brand: item.brand,
        number: item.number,
        body_number: item.body_number,
        chassis_number: item.chassis_number,
        status: item.status,
        theft_date: item.theft_date,
      })),
    },
  };
}

export function compareListingToDecodedVin(
  listing: VehicleLookupListing,
  decoded: DecodedVin,
): string[] {
  const discrepancies: string[] = [];
  if (listing.brand && decoded.make && !sameToken(listing.brand, decoded.make)) {
    discrepancies.push(`Марка в объявлении "${listing.brand}" отличается от марки по VIN "${decoded.make}"`);
  }
  if (listing.model && decoded.model && !modelLooksCompatible(listing.model, decoded.model)) {
    discrepancies.push(`Модель в объявлении "${listing.model}" отличается от модели по VIN "${decoded.model}"`);
  }
  if (listing.year && decoded.year && Math.abs(listing.year - decoded.year) > 1) {
    discrepancies.push(`Год в объявлении ${listing.year} отличается от года по VIN ${decoded.year}`);
  }
  if (
    listing.engineVolume
    && decoded.engineVolume
    && Math.abs(listing.engineVolume - decoded.engineVolume) > 0.35
  ) {
    discrepancies.push(
      `Объем в объявлении ${listing.engineVolume} л отличается от объема по VIN ${decoded.engineVolume} л`,
    );
  }
  if (listing.fuelType && decoded.fuelType && !sameToken(listing.fuelType, decoded.fuelType)) {
    discrepancies.push(`Топливо в объявлении "${listing.fuelType}" отличается от топлива по VIN "${decoded.fuelType}"`);
  }
  if (decoded.errorCode && decoded.errorCode !== "0") {
    discrepancies.push(`Предупреждение VIN-декодера NHTSA: ${decoded.errorText ?? decoded.errorCode}`);
  }
  return discrepancies.slice(0, 8);
}

async function loadStolenIndex(): Promise<StolenIndex | null> {
  if (stolenIndexCache && stolenIndexCache.expiresAt > Date.now()) return stolenIndexCache.index;
  if (stolenIndexPromise) return stolenIndexPromise;
  stolenIndexPromise = fetchStolenIndex()
    .then((index) => {
      if (index) {
        stolenIndexCache = { index, expiresAt: Date.now() + env.DATA_GOV_UA_STOLEN_CACHE_MS };
      }
      return index;
    })
    .finally(() => {
      stolenIndexPromise = null;
    });
  return stolenIndexPromise;
}

async function fetchStolenIndex(): Promise<StolenIndex | null> {
  const response = await sourceHttpClient.json<DataGovUaStolenRow[]>(env.DATA_GOV_UA_STOLEN_URL, {
    source: "DATA_GOV_UA_STOLEN",
    timeoutMs: env.DATA_GOV_UA_STOLEN_TIMEOUT_MS,
    maxBytes: 60_000_000,
  });
  if (response.classification !== "SUCCESS" || !Array.isArray(response.data)) return null;

  const byPlate = new Map<string, DataGovUaStolenRow[]>();
  const byVin = new Map<string, DataGovUaStolenRow[]>();
  for (const row of response.data) {
    const plate = typeof row.number === "string" && row.number.trim() ? normalizePlate(row.number) : null;
    const bodyVin = extractVinFromText(row.body_number ?? undefined);
    const chassisVin = extractVinFromText(row.chassis_number ?? undefined);
    if (plate) pushMap(byPlate, plate, row);
    if (bodyVin) pushMap(byVin, bodyVin, row);
    if (chassisVin) pushMap(byVin, chassisVin, row);
  }
  return { byPlate, byVin, loadedAt: new Date().toISOString(), rows: response.data.length };
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumber(value: unknown): number | null {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 10) / 10 : null;
}

function jsonRecord(row: Record<string, string | null | undefined>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? null]));
}

function sameToken(a: string, b: string): boolean {
  const left = normalizeCompare(a);
  const right = normalizeCompare(b);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function modelLooksCompatible(listingModel: string, decodedModel: string): boolean {
  const left = normalizeCompare(listingModel);
  const right = normalizeCompare(decodedModel);
  return !left || !right || left === right || left.includes(right) || right.includes(left);
}

function normalizeCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/giu, "");
}

function cleanRating(value: unknown): string | null {
  const text = cleanString(value);
  return text && /^[0-5]$/u.test(text) ? text : null;
}

function uniqueStolenRows(rows: DataGovUaStolenRow[]): DataGovUaStolenRow[] {
  const seen = new Set<string>();
  const uniqueRows: DataGovUaStolenRow[] = [];
  for (const row of rows) {
    const key = row.id ?? [row.number, row.body_number, row.chassis_number, row.theft_date].filter(Boolean).join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueRows.push(row);
  }
  return uniqueRows;
}

function pushMap(map: Map<string, DataGovUaStolenRow[]>, key: string, row: DataGovUaStolenRow): void {
  const current = map.get(key);
  if (current) current.push(row);
  else map.set(key, [row]);
}
