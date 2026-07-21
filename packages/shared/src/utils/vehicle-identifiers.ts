import { normalizePlate } from "./normalize.js";

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/iu;
const PLATE_RE =
  /(?:^|[^A-Z0-9\u0410\u0412\u0415\u0406\u0407\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0423\u0425])([A-Z\u0410\u0412\u0415\u0406\u0407\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0423\u0425]{2}[\s-]?\d{4}[\s-]?[A-Z\u0410\u0412\u0415\u0406\u0407\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0423\u0425]{2})(?=$|[^A-Z0-9\u0410\u0412\u0415\u0406\u0407\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0423\u0425])/iu;

export type ExtractedPlate = {
  raw: string;
  normalized: string;
};

export function extractVinFromText(text: string | null | undefined): string | undefined {
  const match = text?.match(VIN_RE);
  return match?.[0]?.toUpperCase();
}

export function extractPlateFromText(text: string | null | undefined): ExtractedPlate | undefined {
  const match = text?.match(PLATE_RE);
  const raw = match?.[1];
  if (!raw) return undefined;
  return {
    raw,
    normalized: normalizePlate(raw),
  };
}
