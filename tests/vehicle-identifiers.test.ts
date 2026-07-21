import { describe, expect, it } from "vitest";
import { extractPlateFromText, extractVinFromText } from "../packages/shared/src/utils/vehicle-identifiers.js";
import { extractPhotoIdentifiers } from "../apps/worker/src/modules/photo-identifier-ocr.js";

describe("vehicle identifier extraction", () => {
  it("extracts VIN codes without I/O/Q ambiguity", () => {
    expect(extractVinFromText("VIN: WBA3A5C50DF123456")).toBe("WBA3A5C50DF123456");
    expect(extractVinFromText("bad WBA3A5C5IDF123456")).toBeUndefined();
  });

  it("extracts and normalizes Ukrainian plates", () => {
    expect(extractPlateFromText("plate AA 1234 BX")?.normalized).toBe("AA1234BX");
    expect(extractPlateFromText("plate \u0410\u0410 1234 \u0412\u0425")?.normalized).toBe("AA1234BX");
  });

  it("extracts VIN and plate from noisy OCR output", () => {
    const result = extractPhotoIdentifiers("VIN WBA3A5C50DF123456\nномер: AA-1234-BX ***");
    expect(result.vin).toBe("WBA3A5C50DF123456");
    expect(result.plateNormalized).toBe("AA1234BX");
  });
});
