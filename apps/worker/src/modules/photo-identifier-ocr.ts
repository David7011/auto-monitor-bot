import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPlateFromText, extractVinFromText } from "@amb/shared";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { env } from "../env.js";
import { fetchPublicBuffer } from "../lib/public-http.js";

export type PhotoIdentifierResult = {
  attempted: boolean;
  imagesProcessed: number;
  vin: string | null;
  plateRaw: string | null;
  plateNormalized: string | null;
  errors: string[];
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const cachePath = path.join(projectRoot, ".runtime", "tesseract-cache");

let workerPromise: Promise<Worker> | null = null;
let serialTail: Promise<void> = Promise.resolve();

export async function inspectListingPhotos(photoUrls: string[]): Promise<PhotoIdentifierResult> {
  if (!env.PHOTO_IDENTIFIER_OCR_ENABLED || photoUrls.length === 0) return emptyResult(false);

  return runSerial(async () => {
    const result = emptyResult(true);
    const urls = [...new Set(photoUrls)].slice(0, env.PHOTO_IDENTIFIER_OCR_MAX_IMAGES);

    for (const url of urls) {
      try {
        const image = await fetchImage(url);
        if (!image) continue;

        const worker = await getWorker();
        const recognition = await withTimeout(
          worker.recognize(image),
          env.PHOTO_IDENTIFIER_OCR_RECOGNIZE_TIMEOUT_MS,
          "Превышено время распознавания фотографии",
        );
        result.imagesProcessed += 1;

        const identifiers = extractPhotoIdentifiers(recognition.data.text);
        result.vin ??= identifiers.vin;
        result.plateRaw ??= identifiers.plateRaw;
        result.plateNormalized ??= identifiers.plateNormalized;
        if (result.vin && result.plateNormalized) break;
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
        await resetWorker();
      }
    }

    return result;
  });
}

export function extractPhotoIdentifiers(text: string): Pick<PhotoIdentifierResult, "vin" | "plateRaw" | "plateNormalized"> {
  const normalized = text
    .toUpperCase()
    .replace(/[\r\n]+/gu, " ")
    .replace(/[^A-Z0-9\s-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const plate = extractPlateFromText(normalized);
  return {
    vin: extractVinFromText(normalized) ?? null,
    plateRaw: plate?.raw ?? null,
    plateNormalized: plate?.normalized ?? null,
  };
}

export async function closePhotoOcrWorker(): Promise<void> {
  await serialTail.catch(() => undefined);
  await resetWorker();
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      await mkdir(cachePath, { recursive: true });
      const worker = await createWorker("eng", OEM.LSTM_ONLY, { cachePath });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ",
        preserve_interword_spaces: "1",
        user_defined_dpi: "150",
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function resetWorker(): Promise<void> {
  const current = workerPromise;
  workerPromise = null;
  if (!current) return;
  try {
    const worker = await current;
    await worker.terminate();
  } catch {
    // A failed OCR worker is discarded and recreated on the next request.
  }
}

async function fetchImage(urlValue: string): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PHOTO_IDENTIFIER_OCR_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchPublicBuffer(urlValue, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/jpeg,image/png,*/*;q=0.5",
        "user-agent": env.SOURCE_HTTP_USER_AGENT,
      },
      signal: controller.signal,
      maxBytes: env.PHOTO_IDENTIFIER_OCR_MAX_BYTES,
    });
    if (!response.ok) throw new Error(`Фото недоступно: HTTP ${response.status}`);

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.startsWith("image/")) throw new Error("Ответ не является изображением");

    return response.body;
  } finally {
    clearTimeout(timeout);
  }
}

function runSerial<T>(task: () => Promise<T>): Promise<T> {
  const result = serialTail.then(task, task);
  serialTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function emptyResult(attempted: boolean): PhotoIdentifierResult {
  return {
    attempted,
    imagesProcessed: 0,
    vin: null,
    plateRaw: null,
    plateNormalized: null,
    errors: [],
  };
}
