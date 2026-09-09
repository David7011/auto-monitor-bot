import { describe, expect, it } from "vitest";
import {
  autoRiaIdentityIssues,
  autoRiaRequestPlan,
  autoRiaRealtimeIntervalSeconds,
  autoRiaSearchBudgetPerHour,
} from "../apps/api/src/lib/auto-ria-plan.js";

describe("AUTO.RIA planner semantics", () => {
  it("keeps an intentional all-makes filter complete instead of inventing a mark id", () => {
    expect(autoRiaIdentityIssues({
      brand: null,
      model: null,
      autoRiaMarkId: null,
      autoRiaModelId: null,
    })).toEqual([expect.objectContaining({ level: "ok" })]);
  });

  it("requires an official mark id when a concrete brand was requested", () => {
    expect(autoRiaIdentityIssues({
      brand: "Toyota",
      model: "Camry",
      autoRiaMarkId: null,
      autoRiaModelId: null,
    })).toEqual([expect.objectContaining({ level: "danger" })]);
  });

  it("keeps public mode operational without requiring API taxonomy ids", () => {
    expect(autoRiaIdentityIssues({
      brand: "Toyota",
      model: "Camry",
      autoRiaMarkId: null,
      autoRiaModelId: null,
    }, "public")).toEqual([expect.objectContaining({ level: "warning" })]);
  });

  it("reports stable, burst, and observed request costs separately", () => {
    expect(autoRiaRequestPlan(10, 2)).toEqual({
      expectedRequestsPerScan: 1,
      maximumRequestsPerScan: 11,
      recentRequestsPerScan: 2,
    });
  });

  it("reserves one full detail burst inside the hourly quota", () => {
    expect(autoRiaSearchBudgetPerHour(30, 30, 10)).toBe(20);
    expect(autoRiaSearchBudgetPerHour(12, 30, 10)).toBe(12);
  });

  it("does not apply API quota pacing to the keyless public strategy", () => {
    expect(autoRiaRealtimeIntervalSeconds({
      accessMode: "public",
      sourceIntervalSeconds: 60,
      minimumIntervalSeconds: 60,
      contextCount: 1,
      hourlySearchBudget: 20,
    })).toBe(60);
    expect(autoRiaRealtimeIntervalSeconds({
      accessMode: "api",
      sourceIntervalSeconds: 60,
      minimumIntervalSeconds: 60,
      contextCount: 1,
      hourlySearchBudget: 20,
    })).toBe(180);
  });
});
