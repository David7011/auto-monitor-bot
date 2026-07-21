import { describe, expect, it } from "vitest";
import { withPageNumber } from "../apps/worker/src/collectors/html-utils.js";
import { carsUaPageUrl } from "../apps/worker/src/collectors/cars-ua.js";
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

  it("uses the path pagination format required by Cars.ua", () => {
    expect(carsUaPageUrl("https://cars.ua/", 2)).toBe("https://cars.ua/p=2/");
    expect(carsUaPageUrl("https://cars.ua/avtobazar/dnepr/", 4)).toBe("https://cars.ua/avtobazar/dnepr/p=4/");
  });
});
