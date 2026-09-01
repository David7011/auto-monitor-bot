import { describe, expect, it } from "vitest";
import { formatSourceHealthLine } from "../apps/api/src/modules/telegram-control-format.js";

describe("Telegram source health formatting", () => {
  const now = new Date("2026-08-19T17:00:00.000Z");

  it("shows an active source with its real freshness", () => {
    expect(formatSourceHealthLine({
      source: "CARS_UA",
      status: "ACTIVE",
      lastSuccessfulAt: new Date("2026-08-19T16:59:52.000Z"),
      pausedUntil: null,
    }, now)).toBe("✅ Cars.ua — работает, успех 8 сек. назад");
  });

  it("makes a protected OLX outage and the next probe visible", () => {
    const line = formatSourceHealthLine({
      source: "OLX",
      status: "RATE_LIMITED",
      lastSuccessfulAt: new Date("2026-08-10T16:00:00.000Z"),
      pausedUntil: new Date("2026-08-20T14:01:00.000Z"),
    }, now);
    expect(line).toContain("⛔ OLX — HTTP-ограничение");
    expect(line).toContain("успех 9 дн. назад");
    expect(line).toContain("повтор 20.08 17:01");
  });
});
