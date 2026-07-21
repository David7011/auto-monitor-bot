import { afterEach, describe, expect, it } from "vitest";
import { signDashboardSession, verifyDashboardSession } from "../apps/dashboard/lib/dashboard-auth.js";

const originalDashboardSecret = process.env.DASHBOARD_AUTH_SECRET;
const originalApiToken = process.env.LOCAL_API_TOKEN;

afterEach(() => {
  restore("DASHBOARD_AUTH_SECRET", originalDashboardSecret);
  restore("LOCAL_API_TOKEN", originalApiToken);
});

describe("dashboard session secret isolation", () => {
  it("signs and verifies with the dedicated dashboard secret", async () => {
    process.env.DASHBOARD_AUTH_SECRET = "dashboard-secret-that-is-long-and-independent";
    process.env.LOCAL_API_TOKEN = "different-local-api-token";
    const token = await signDashboardSession("operator", 2);
    expect(await verifyDashboardSession(token)).toEqual({ ok: true, username: "operator", authVersion: 2 });
  });

  it("does not fall back to the local API token", async () => {
    delete process.env.DASHBOARD_AUTH_SECRET;
    process.env.LOCAL_API_TOKEN = "local-api-token-must-not-sign-browser-sessions";
    await expect(signDashboardSession("operator", 1)).rejects.toThrow("DASHBOARD_AUTH_SECRET");
  });
});

function restore(key: string, value: string | undefined): void {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}
