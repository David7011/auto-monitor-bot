import { describe, expect, it } from "vitest";
import { withPageNumber } from "../apps/worker/src/collectors/html-utils.js";
import {
  carsUaPageIsAnchored,
  carsUaPageUrl,
  carsUaSearchUrls,
} from "../apps/worker/src/collectors/cars-ua.js";
import { autoMotoSearchUrls } from "../apps/worker/src/collectors/automoto.js";
import { QUEUE_NAMES, QUEUE_PRIORITIES } from "../packages/shared/src/constants/queues.js";

describe("backfill primitives", () => {
  it("adds and replaces page parameters without losing source ordering", () => {
    const first = withPageNumber("https://example.test/cars?order=created_at%3Adesc", 1);
    const fourth = withPageNumber(first, 4);
    expect(new URL(fourth).searchParams.get("page")).toBe("4");
    expect(new URL(fourth).searchParams.get("order")).toBe("created_at:desc");
  });

  it("keeps backfill behind the realtime queue", () => {
    expect(QUEUE_PRIORITIES[QUEUE_NAMES.COLLECTOR_BACKFILL]).toBeGreaterThan(
      QUEUE_PRIORITIES[QUEUE_NAMES.COLLECTOR_RUN],
    );
  });

  it("keeps durable coverage behind the realtime queue", () => {
    expect(QUEUE_PRIORITIES[QUEUE_NAMES.COLLECTOR_COVERAGE]).toBeGreaterThan(
      QUEUE_PRIORITIES[QUEUE_NAMES.COLLECTOR_RUN],
    );
  });

  it("uses the path pagination format required by Cars.ua", () => {
    expect(carsUaPageUrl("https://cars.ua/", 2)).toBe("https://cars.ua/p=2/");
    expect(carsUaPageUrl("https://cars.ua/avtobazar/dnepr/", 4)).toBe("https://cars.ua/avtobazar/dnepr/p=4/");
  });

  it("uses city-specific Cars.ua hot feeds when the filter selects supported cities", () => {
    expect(carsUaSearchUrls("https://cars.ua/", ["dnipro"])).toEqual([
      "https://cars.ua/avtobazar/dnepr/",
    ]);
    expect(carsUaSearchUrls("https://cars.ua/?order=date", ["dnipro", "odesa"])).toEqual([
      "https://cars.ua/avtobazar/dnepr/?order=date",
      "https://cars.ua/avtobazar/odessa/?order=date",
    ]);
  });

  it("keeps the national Cars.ua feed for unsupported or empty city selections", () => {
    expect(carsUaSearchUrls("https://cars.ua/", [])).toEqual(["https://cars.ua/"]);
    expect(carsUaSearchUrls("https://cars.ua/", ["katottg-unknown"])).toEqual(["https://cars.ua/"]);
  });

  it("uses city-specific AutoMoto hot feeds and preserves newest-first query", () => {
    expect(autoMotoSearchUrls("https://automoto.ua/uk/car?order=addDate", ["dnipro"])).toEqual([
      "https://automoto.ua/uk/city/Dnepr-Dnepropetrovsk/car?order=addDate",
    ]);
    expect(autoMotoSearchUrls("https://automoto.ua/uk/car?order=addDate", ["dnipro", "odesa"])).toEqual([
      "https://automoto.ua/uk/city/Dnepr-Dnepropetrovsk/car?order=addDate",
      "https://automoto.ua/uk/city/Odessa/car?order=addDate",
    ]);
  });

  it("keeps the national AutoMoto feed for unsupported or empty city selections", () => {
    expect(autoMotoSearchUrls("https://automoto.ua/uk/car?order=addDate", [])).toEqual([
      "https://automoto.ua/uk/car?order=addDate",
    ]);
    expect(autoMotoSearchUrls("https://automoto.ua/uk/car?order=addDate", ["katottg-unknown"])).toEqual([
      "https://automoto.ua/uk/car?order=addDate",
    ]);
  });

  it("opens the next Cars.ua page when a mixed page has no reliable known tail", () => {
    expect(carsUaPageIsAnchored([true, false, true], 10)).toBe(false);
    expect(carsUaPageIsAnchored([true, true, true], 10)).toBe(true);
    expect(carsUaPageIsAnchored([false, ...Array<boolean>(10).fill(true)], 10)).toBe(true);
  });
});
