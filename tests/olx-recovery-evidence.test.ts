import { describe, expect, it } from "vitest";
import { olxRecoveryPageEvidence, olxRecoveryPageEvidenceMatches } from "../apps/worker/src/collectors/olx.js";
import type { OlxFeedResult } from "../apps/worker/src/collectors/olx-feed.js";

function page(ids: string[], channel: "OLX_PUBLIC_HTML" | "OLX_PUBLIC_API" | "OLX_PRIVATE_API" = "OLX_PUBLIC_HTML", target = "scope;page:1"): OlxFeedResult {
  return { primary: true, url: "https://www.olx.ua/", observationTarget: target, channel,
    requestCount: 1, ads: ids.map((id) => ({ id })) };
}

describe("OLX full-page recovery evidence", () => {
  it("accepts a permutation of exactly the ingested page, including duplicate multiplicity", () => {
    const expected = olxRecoveryPageEvidence([page(["1", "2", "3", "2"])]);
    expect(olxRecoveryPageEvidenceMatches(expected, olxRecoveryPageEvidence([page(["2", "3", "2", "1"])]))).toBe(true);
    expect(olxRecoveryPageEvidenceMatches(expected, olxRecoveryPageEvidence([page(["2", "3", "1"])]))).toBe(false);
  });
  it.each([["1", "2"], ["1", "2", "4"], ["1", "2", "3", "4"]])("rejects changed membership %j", (...ids) => {
    expect(olxRecoveryPageEvidenceMatches(olxRecoveryPageEvidence([page(["1", "2", "3"])]),
      olxRecoveryPageEvidence([page(ids)]))).toBe(false);
  });
  it("rejects a channel switch, missing secondary scope or private feed", () => {
    const expected = olxRecoveryPageEvidence([page(["1"]), page(["2"], "OLX_PRIVATE_API", "private;page:1")]);
    expect(olxRecoveryPageEvidenceMatches(expected, olxRecoveryPageEvidence([page(["1"], "OLX_PUBLIC_API"), page(["2"], "OLX_PRIVATE_API", "private;page:1")]))).toBe(false);
    expect(olxRecoveryPageEvidenceMatches(expected, olxRecoveryPageEvidence([page(["1"])]))).toBe(false);
  });
  it("rejects empty, legacy, unidentifiable or ambiguous evidence", () => {
    expect(olxRecoveryPageEvidenceMatches([], [])).toBe(false);
    const valid = olxRecoveryPageEvidence([page(["1"])]);
    expect(olxRecoveryPageEvidenceMatches(["olx-offset-evidence-v1", valid[1]!], valid)).toBe(false);
    expect(olxRecoveryPageEvidence([page(["1", ""])] )).toEqual([]);
    expect(olxRecoveryPageEvidence([page(["1"]), page(["2"])] )).toEqual([]);
  });
});
