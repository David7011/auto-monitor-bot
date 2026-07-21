import { prisma, type VehicleCheck } from "@amb/db";
import { extractPlateFromText, extractVinFromText, normalizePlate } from "@amb/shared";
import { sourceHttpClient } from "../collectors/source-http-client.js";
import { env } from "../env.js";
import { inspectListingPhotos, type PhotoIdentifierResult } from "./photo-identifier-ocr.js";

type ListingForCheck = NonNullable<Awaited<ReturnType<typeof loadListing>>>;

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

type RecallLookup = {
  checked: boolean;
  count: number;
  campaigns: string[];
  raw: object | null;
};

type ComplaintsLookup = {
  checked: boolean;
  count: number;
  raw: object | null;
};

type SafetyLookup = {
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

type StolenLookup = {
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

type DecodedVin = {
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

type CheckData = {
  plateRaw?: string | null;
  plateNormalized?: string | null;
  vin?: string | null;
  checkStatus:
    | "NO_PLATE_OR_VIN_FOUND"
    | "PLATE_FOUND"
    | "VIN_FOUND"
    | "CHECK_DONE"
    | "CHECK_PARTIAL"
    | "CHECK_FAILED";
  make?: string | null;
  model?: string | null;
  year?: number | null;
  engineVolume?: number | null;
  fuelType?: string | null;
  bodyType?: string | null;
  driveType?: string | null;
  color?: string | null;
  mileage?: number | null;
  accidents?: string | null;
  restrictions?: string | null;
  provider?: string | null;
  discrepancies?: string[];
  rawResponse?: object;
};

let stolenIndexCache: { expiresAt: number; index: StolenIndex } | null = null;
let stolenIndexPromise: Promise<StolenIndex | null> | null = null;

/** Runs after the first Telegram alert and never blocks the urgent notification path. */
export async function runVehicleCheck(listingId: string): Promise<void> {
  if (env.FAKE_VEHICLE_CHECK_ENABLED) {
    await runFakeVehicleCheck(listingId);
    return;
  }
  await runRealVehicleCheck(listingId);
}

async function runRealVehicleCheck(listingId: string): Promise<void> {
  const providerTimingsMs: Record<string, number> = {};
  const listing = await loadListing(listingId);
  if (!listing) throw new Error(`Listing not found: ${listingId}`);
  await markCheckPending(listingId);

  const haystack = listingIdentifierText(listing);
  const textVin = listing.vin ?? extractVinFromText(haystack) ?? null;
  const textPlate = listing.plateNormalized
    ? { raw: listing.plateNormalized, normalized: listing.plateNormalized }
    : extractPlateFromText(haystack);
  const photoOcr = !textVin || !textPlate?.normalized
    ? await timed("photoOcr", providerTimingsMs, () => inspectListingPhotos(listing.photoUrls))
    : emptyPhotoResult();
  const vin = textVin ?? photoOcr.vin;
  const plateRaw = textPlate?.raw ?? photoOcr.plateRaw;
  const plateNormalized = textPlate?.normalized ?? photoOcr.plateNormalized;

  if (!vin && !plateNormalized) {
    await upsertCheck(listingId, {
      checkStatus: "NO_PLATE_OR_VIN_FOUND",
      model: listing.title,
      year: listing.year,
      mileage: listing.mileage,
      provider: photoOcr.attempted ? "listing_text+photo_ocr" : "listing_text",
      rawResponse: {
        reason: "VIN и государственный номер не найдены в тексте и доступных фотографиях",
        photoOcr,
        generatedAt: new Date().toISOString(),
      },
    });
    return;
  }

  await prisma.listing.update({
    where: { id: listingId },
    data: {
      vin: listing.vin ?? vin,
      plateNormalized: listing.plateNormalized ?? plateNormalized,
    },
  });

  const reusable = await findReusableVehicleCheck(listingId, vin, plateNormalized);
  if (reusable) {
    await reuseVehicleCheck(listingId, reusable, providerTimingsMs);
    return;
  }

  const decoded = vin && env.NHTSA_VPIC_ENABLED
    ? await timed("nhtsaVpic", providerTimingsMs, () => decodeVinWithNhtsa(vin, listing.year))
    : null;
  const decodedVehicle = decoded?.decoded ?? null;
  const [recalls, complaints, safety, stolen] = await Promise.all([
    timed("nhtsaRecalls", providerTimingsMs, () => lookupNhtsaRecalls(listing, decodedVehicle)),
    timed("nhtsaComplaints", providerTimingsMs, () => lookupNhtsaComplaints(listing, decodedVehicle)),
    timed("nhtsaSafety", providerTimingsMs, () => lookupNhtsaSafety(listing, decodedVehicle)),
    timed("dataGovUaStolen", providerTimingsMs, () => lookupDataGovUaStolen(plateNormalized, vin)),
  ]);
  const discrepancies = decoded?.decoded ? compareListingToDecodedVin(listing, decoded.decoded) : [];
  if (stolen.found) {
    discrepancies.unshift(
      "Есть совпадение в украинском реестре автомобилей в розыске. Проверь данные вручную до звонка продавцу.",
    );
  }
  const providerFailures = publicProviderFailures({ vin, decoded, recalls, complaints, safety, stolen });
  if (providerFailures.length > 0) {
    discrepancies.push(`Проверка открытых источников неполна: ${providerFailures.join(", ")}.`);
  }

  const provider = providerSummary(
    Boolean(decoded),
    recalls.checked,
    complaints.checked,
    safety.checked,
    stolen.checked,
    photoOcr.imagesProcessed > 0,
  );
  await upsertCheck(listingId, {
    plateRaw,
    plateNormalized,
    vin,
    checkStatus: decoded?.decoded && providerFailures.length === 0 ? "CHECK_DONE" : "CHECK_PARTIAL",
    make: decoded?.decoded?.make ?? listing.brand,
    model: decoded?.decoded?.model ?? listing.model ?? listing.title,
    year: decoded?.decoded?.year ?? listing.year,
    engineVolume: decoded?.decoded?.engineVolume ?? listing.engineVolume,
    fuelType: decoded?.decoded?.fuelType ?? listing.fuelType,
    bodyType: decoded?.decoded?.bodyType ?? listing.bodyType,
    driveType: decoded?.decoded?.driveType ?? listing.driveType,
    mileage: listing.mileage,
    // Public providers used here do not contain a reliable accident history.
    // Stolen-registry matches belong to restrictions/discrepancies instead.
    accidents: null,
    restrictions: formatRestrictions(recalls, complaints, safety, stolen),
    provider,
    discrepancies,
    rawResponse: {
      source: provider,
      extracted: {
        vin: Boolean(vin),
        plate: Boolean(plateNormalized),
        vinFromPhoto: Boolean(photoOcr.vin),
        plateFromPhoto: Boolean(photoOcr.plateNormalized),
      },
      photoOcr,
      nhtsa: decoded?.raw ?? {
        enabled: env.NHTSA_VPIC_ENABLED,
        skipped: !vin ? "no_vin" : "disabled",
      },
      nhtsaRecalls: recalls.raw ?? {
        enabled: env.NHTSA_RECALLS_ENABLED,
        skipped: recalls.checked ? "no_results" : "missing_make_model_year_or_disabled",
      },
      nhtsaComplaints: complaints.raw ?? {
        enabled: env.NHTSA_COMPLAINTS_ENABLED,
        skipped: complaints.checked ? "no_results" : "missing_make_model_year_or_disabled",
      },
      nhtsaSafetyRatings: safety.raw ?? {
        enabled: env.NHTSA_SAFETY_RATINGS_ENABLED,
        skipped: safety.checked ? "no_results" : "missing_make_model_year_or_disabled",
      },
      dataGovUaStolen: stolen.raw ?? {
        enabled: env.DATA_GOV_UA_STOLEN_ENABLED,
        skipped: stolen.checked ? "no_match" : "missing_plate_or_vin_or_disabled",
      },
      providerTimingsMs,
      generatedAt: new Date().toISOString(),
    },
  });
}

function publicProviderFailures(input: {
  vin: string | null;
  decoded: { decoded: DecodedVin | null; raw: object } | null;
  recalls: RecallLookup;
  complaints: ComplaintsLookup;
  safety: SafetyLookup;
  stolen: StolenLookup;
}): string[] {
  const failures: string[] = [];
  if (input.vin && env.NHTSA_VPIC_ENABLED && !input.decoded?.decoded) failures.push("VIN decode");
  if (rawProviderFailed(input.recalls.raw)) failures.push("recalls");
  if (rawProviderFailed(input.complaints.raw)) failures.push("complaints");
  if (rawProviderFailed(input.safety.raw)) failures.push("safety ratings");
  if (rawProviderFailed(input.stolen.raw)) failures.push("украинский реестр розыска");
  return failures;
}

function rawProviderFailed(raw: object | null): boolean {
  if (!raw) return false;
  const value = raw as Record<string, unknown>;
  if (typeof value.error === "string" && value.error) return true;
  return typeof value.classification === "string" && value.classification !== "SUCCESS";
}

async function findReusableVehicleCheck(
  listingId: string,
  vin: string | null,
  plateNormalized: string | null,
): Promise<VehicleCheck | null> {
  const identities = [];
  if (vin) {
    identities.push({ vin, updatedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } });
  }
  if (plateNormalized) {
    identities.push({ plateNormalized, updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
  }
  if (identities.length === 0) return null;
  return prisma.vehicleCheck.findFirst({
    where: {
      listingId: { not: listingId },
      checkStatus: { in: ["CHECK_DONE", "CHECK_PARTIAL"] },
      OR: identities,
    },
    orderBy: { updatedAt: "desc" },
  });
}

async function reuseVehicleCheck(
  listingId: string,
  reusable: VehicleCheck,
  providerTimingsMs: Record<string, number>,
): Promise<void> {
  await upsertCheck(listingId, {
    plateRaw: reusable.plateRaw,
    plateNormalized: reusable.plateNormalized,
    vin: reusable.vin,
    checkStatus: reusable.checkStatus === "CHECK_DONE" ? "CHECK_DONE" : "CHECK_PARTIAL",
    make: reusable.make,
    model: reusable.model,
    year: reusable.year,
    engineVolume: reusable.engineVolume,
    fuelType: reusable.fuelType,
    bodyType: reusable.bodyType,
    driveType: reusable.driveType,
    color: reusable.color,
    mileage: reusable.mileage,
    accidents: reusable.accidents,
    restrictions: reusable.restrictions,
    provider: `${reusable.provider ?? "vehicle_check"}+cache`,
    discrepancies: reusable.discrepancies,
    rawResponse: {
      reusedFromCheckId: reusable.id,
      originalProvider: reusable.provider,
      originalUpdatedAt: reusable.updatedAt.toISOString(),
      providerTimingsMs,
      generatedAt: new Date().toISOString(),
    },
  });
}

async function timed<T>(name: string, timings: Record<string, number>, task: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    timings[name] = Math.round(performance.now() - startedAt);
  }
}

export async function runFakeVehicleCheck(listingId: string): Promise<void> {
  const listing = await loadListing(listingId);
  if (!listing) throw new Error(`Listing not found: ${listingId}`);

  await markCheckPending(listingId);
  await sleep(3_000 + Math.random() * 2_000);
  if (Math.random() <= 0.5) {
    await upsertCheck(listingId, {
      checkStatus: "NO_PLATE_OR_VIN_FOUND",
      provider: "fake",
      rawResponse: { fake: true, generatedAt: new Date().toISOString() },
    });
    return;
  }

  const plateRaw = `AA ${1_000 + Math.floor(Math.random() * 9_000)} BX`;
  const vin = Math.random() > 0.5 ? `WBA${Math.random().toString(36).slice(2, 16).toUpperCase()}`.slice(0, 17) : null;
  await upsertCheck(listingId, {
    plateRaw,
    plateNormalized: normalizePlate(plateRaw),
    vin,
    checkStatus: vin ? "CHECK_DONE" : "CHECK_PARTIAL",
    make: listing.brand,
    model: listing.model ?? listing.title,
    year: listing.year,
    engineVolume: listing.engineVolume,
    fuelType: listing.fuelType,
    bodyType: listing.bodyType,
    driveType: listing.driveType,
    mileage: listing.mileage,
    accidents: "Тестовая проверка",
    restrictions: "Тестовая проверка",
    provider: "fake",
    rawResponse: { fake: true, generatedAt: new Date().toISOString() },
  });
}

async function decodeVinWithNhtsa(
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

async function lookupNhtsaRecalls(listing: ListingForCheck, decoded: DecodedVin | null): Promise<RecallLookup> {
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

async function lookupNhtsaComplaints(listing: ListingForCheck, decoded: DecodedVin | null): Promise<ComplaintsLookup> {
  const make = decoded?.make ?? listing.brand;
  const model = decoded?.model ?? listing.model;
  const year = decoded?.year ?? listing.year;
  if (!env.NHTSA_COMPLAINTS_ENABLED || !make || !model || !year) return { checked: false, count: 0, raw: null };

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

async function lookupNhtsaSafety(listing: ListingForCheck, decoded: DecodedVin | null): Promise<SafetyLookup> {
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

async function lookupDataGovUaStolen(plateNormalized: string | null, vin: string | null): Promise<StolenLookup> {
  if (!env.DATA_GOV_UA_STOLEN_ENABLED || (!plateNormalized && !vin)) {
    return { checked: false, found: false, matches: [], raw: null };
  }

  const index = await loadStolenIndex();
  if (!index) return { checked: true, found: false, matches: [], raw: { error: "stolen_index_unavailable" } };
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

async function loadStolenIndex(): Promise<StolenIndex | null> {
  if (stolenIndexCache && stolenIndexCache.expiresAt > Date.now()) return stolenIndexCache.index;
  if (stolenIndexPromise) return stolenIndexPromise;
  stolenIndexPromise = fetchStolenIndex()
    .then((index) => {
      if (index) stolenIndexCache = { index, expiresAt: Date.now() + env.DATA_GOV_UA_STOLEN_CACHE_MS };
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

function compareListingToDecodedVin(listing: ListingForCheck, decoded: DecodedVin): string[] {
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
  if (listing.engineVolume && decoded.engineVolume && Math.abs(listing.engineVolume - decoded.engineVolume) > 0.35) {
    discrepancies.push(`Объем в объявлении ${listing.engineVolume} л отличается от объема по VIN ${decoded.engineVolume} л`);
  }
  if (listing.fuelType && decoded.fuelType && !sameToken(listing.fuelType, decoded.fuelType)) {
    discrepancies.push(`Топливо в объявлении "${listing.fuelType}" отличается от топлива по VIN "${decoded.fuelType}"`);
  }
  if (decoded.errorCode && decoded.errorCode !== "0") {
    discrepancies.push(`Предупреждение VIN-декодера NHTSA: ${decoded.errorText ?? decoded.errorCode}`);
  }
  return discrepancies.slice(0, 8);
}

async function loadListing(listingId: string) {
  return prisma.listing.findUnique({ where: { id: listingId } });
}

async function markCheckPending(listingId: string): Promise<void> {
  const existing = await prisma.vehicleCheck.findFirst({ where: { listingId }, orderBy: { createdAt: "desc" } });
  if (existing) {
    await prisma.vehicleCheck.update({ where: { id: existing.id }, data: { checkStatus: "PENDING" } });
    return;
  }
  await prisma.vehicleCheck.create({ data: { listingId, checkStatus: "PENDING" } });
}

async function upsertCheck(listingId: string, data: CheckData): Promise<void> {
  const existing = await prisma.vehicleCheck.findFirst({ where: { listingId }, orderBy: { createdAt: "desc" } });
  if (existing) {
    await prisma.vehicleCheck.update({ where: { id: existing.id }, data });
  } else {
    await prisma.vehicleCheck.create({ data: { listingId, ...data } });
  }
  await prisma.listing.update({ where: { id: listingId }, data: { status: "ENRICHED" } });
}

function listingIdentifierText(listing: ListingForCheck): string {
  return [
    listing.title,
    listing.brand,
    listing.model,
    listing.description,
    listing.sellerPhone,
    listing.vin,
    listing.plateNormalized,
    safeStringify(listing.rawData),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, 20_000);
}

function safeStringify(value: unknown): string | undefined {
  if (!value) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
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

function formatRestrictions(
  recalls: RecallLookup,
  complaints: ComplaintsLookup,
  safety: SafetyLookup,
  stolen: StolenLookup,
): string | null {
  const parts: string[] = [];
  if (stolen.checked) parts.push(stolen.found ? "Розыск: есть совпадение" : "Розыск: совпадений нет");
  if (recalls.checked) {
    parts.push(recalls.count > 0 ? `Отзывные кампании NHTSA: ${recalls.count}` : "Отзывные кампании NHTSA: не найдены");
  }
  if (complaints.checked) parts.push(`Жалобы владельцев NHTSA: ${complaints.count}`);
  if (safety.checked && safety.overallRating) parts.push(`Безопасность NHTSA: ${safety.overallRating}/5`);
  return parts.length ? parts.join("; ") : null;
}

function providerSummary(
  vpicChecked: boolean,
  recallsChecked: boolean,
  complaintsChecked: boolean,
  safetyChecked: boolean,
  stolenChecked: boolean,
  photoOcrUsed: boolean,
): string {
  return [
    "listing_text",
    photoOcrUsed ? "photo_ocr" : null,
    vpicChecked ? "nhtsa_vpic" : null,
    recallsChecked ? "nhtsa_recalls" : null,
    complaintsChecked ? "nhtsa_complaints" : null,
    safetyChecked ? "nhtsa_safety" : null,
    stolenChecked ? "data_gov_ua_stolen" : null,
  ]
    .filter(Boolean)
    .join("+");
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

function emptyPhotoResult(): PhotoIdentifierResult {
  return { attempted: false, imagesProcessed: 0, vin: null, plateRaw: null, plateNormalized: null, errors: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
