import { describe, expect, it } from "vitest";
import {
  assertNoVanishedCandidates,
  DeterministicMarketplace,
  DurableFakeLedger,
  FakeTransportError,
  type FakeFault,
} from "./support/deterministic-marketplace.js";

describe("deterministic newest-first marketplace completeness harness", () => {
  it.each([1, 2, 10, 50])("journals a burst of %i before processing its first item", (size) => {
    const market = new DeterministicMarketplace();
    market.publish(size, { prefix: `burst-${size}` });
    const page = market.fetchPage(1, 100);
    const delivered = new Set(page.candidates.map((candidate) => candidate.id));
    const ledger = new DurableFakeLedger();

    ledger.persistBatch(page.candidates);
    // Simulated process death after the first per-item dispatch cannot erase
    // the rest of the already committed callback batch.
    ledger.finish(page.candidates[0]!.id, "NOTIFIED");

    expect(ledger.observations.size).toBe(size);
    assertNoVanishedCandidates(delivered, ledger);
  });

  it("keeps equal and missing publication timestamps as distinct durable IDs", () => {
    const market = new DeterministicMarketplace();
    const equal = market.publish(10, { timestamp: new Date("2026-09-12T08:30:00Z"), prefix: "equal" });
    const unknown = market.publish(10, { timestamp: null, prefix: "unknown" });
    const page = market.fetchPage(1, 50);
    const ledger = new DurableFakeLedger();
    ledger.persistBatch(page.candidates);
    assertNoVanishedCandidates(new Set([...equal, ...unknown].map((item) => item.id)), ledger);
  });

  it.each([
    "EMPTY", "PARTIAL", "PARSER_DEGRADED", "HTTP_403", "HTTP_429", "CAPTCHA", "HTTP_500",
  ] satisfies FakeFault[])("models %s without inventing normalized candidates", (fault) => {
    const market = new DeterministicMarketplace();
    market.publish(10);
    market.enqueueFault(fault);
    const page = market.fetchPage(1, 10);
    const ledger = new DurableFakeLedger();
    const delivered = new Set(page.candidates.map((candidate) => candidate.id));
    ledger.persistBatch(page.candidates);
    assertNoVanishedCandidates(delivered, ledger);
    if (fault === "PARSER_DEGRADED") expect(page.parserHealth).toBe("DEGRADED");
    if (["HTTP_403", "HTTP_429", "CAPTCHA", "HTTP_500"].includes(fault)) expect(page.protection).not.toBe("NONE");
  });

  it.each(["TIMEOUT", "CONNECTION_RESET"] satisfies FakeFault[])("models %s before normalized delivery", (fault) => {
    const market = new DeterministicMarketplace();
    market.publish(1);
    market.enqueueFault(fault);
    expect(() => market.fetchPage(1, 10)).toThrow(FakeTransportError);
  });

  it("preserves every delivered ID across duplicates and page movement", () => {
    const market = new DeterministicMarketplace();
    market.publish(20, { prefix: "old" });
    const ledger = new DurableFakeLedger();
    const delivered = new Set<string>();
    const first = market.fetchPage(1, 10);
    first.candidates.forEach((candidate) => delivered.add(candidate.id));
    ledger.persistBatch(first.candidates);

    // New publications shift old page-1 records onto page 2. Overlap creates
    // duplicates, which must remain harmless because the ledger is keyed by ID.
    market.publish(5, { prefix: "new" });
    const shiftedSecond = market.fetchPage(2, 10);
    shiftedSecond.candidates.forEach((candidate) => delivered.add(candidate.id));
    ledger.persistBatch(shiftedSecond.candidates);
    ledger.persistBatch(shiftedSecond.candidates);

    assertNoVanishedCandidates(delivered, ledger);
    expect(ledger.observations.size).toBe(delivered.size);
  });

  it("marks a public pagination ceiling instead of claiming false exhaustion", () => {
    const market = new DeterministicMarketplace(20);
    market.publish(50);
    expect(market.fetchPage(3, 10)).toMatchObject({ capped: true, candidates: [] });
  });
});
