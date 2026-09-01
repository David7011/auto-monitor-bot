import { prisma, type VehicleCheck } from "@amb/db";
import { extractPlateFromText, extractVinFromText, normalizePlate } from "@amb/shared";
import { env } from "../env.js";
import { inspectListingPhotos, type PhotoIdentifierResult } from "./photo-identifier-ocr.js";
import {
  compareListingToDecodedVin,
  decodeVinWithNhtsa,
  lookupDataGovUaStolen,
  lookupNhtsaComplaints,
  lookupNhtsaRecalls,
  lookupNhtsaSafety,
  type ComplaintsLookup,
  type DecodedVin,
  type RecallLookup,
  type SafetyLookup,
  type StolenLookup,
} from "./vehicle-check-providers.js";

type ListingForCheck = NonNullable<Awaited<ReturnType<typeof loadListing>>>;

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

function emptyPhotoResult(): PhotoIdentifierResult {
  return { attempted: false, imagesProcessed: 0, vin: null, plateRaw: null, plateNormalized: null, errors: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
