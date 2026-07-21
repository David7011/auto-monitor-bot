import { describe, expect, it } from "vitest";
import { FUEL_TYPE_OPTIONS, findAttributeValue } from "../packages/shared/src/utils/vehicle-attributes.js";
import { decodeHtmlEntities, parseEngineVolume } from "../apps/worker/src/collectors/html-utils.js";

describe("fuel classification", () => {
  it("classifies dual-fuel 'газ / бензин' as gas, not gasoline", () => {
    expect(findAttributeValue("газ / бензин", FUEL_TYPE_OPTIONS)).toBe("gas");
  });

  it("still classifies plain бензин as gasoline", () => {
    expect(findAttributeValue("Бензин", FUEL_TYPE_OPTIONS)).toBe("gasoline");
  });

  it("classifies ГБО as gas", () => {
    expect(findAttributeValue("ГБО", FUEL_TYPE_OPTIONS)).toBe("gas");
  });
});

describe("parseEngineVolume", () => {
  it("does not misread horsepower 'л.с.' as engine volume", () => {
    expect(parseEngineVolume("Бензин, 150 л.с.")).toBeUndefined();
  });

  it("parses a litre volume", () => {
    expect(parseEngineVolume("2.0 л")).toBe(2);
  });

  it("parses a cc volume into litres", () => {
    expect(parseEngineVolume("1998 см3")).toBe(2);
  });
});

describe("decodeHtmlEntities", () => {
  it("keeps an escaped entity intact (&amp;lt; stays &lt;)", () => {
    expect(decodeHtmlEntities("a &amp;lt; b")).toBe("a &lt; b");
  });

  it("decodes ordinary entities", () => {
    expect(decodeHtmlEntities("Toyota &amp; Lexus &lt;3")).toBe("Toyota & Lexus <3");
  });
});
