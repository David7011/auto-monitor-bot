import { describe, expect, it } from "vitest";
import { isTelegramMediaRejected } from "../apps/worker/src/modules/telegram-service.js";

describe("telegram media rejection fallback", () => {
  it("downgrades WEBPAGE_CURL_FAILED album sends to text", () => {
    expect(isTelegramMediaRejected(new Error(
      "Call to 'sendMediaGroup' failed! (400: Bad Request: failed to send message #1 with the error message \"WEBPAGE_CURL_FAILED\")",
    ))).toBe(true);
  });

  it("keeps recognizing the known dead-media verdicts", () => {
    for (const message of [
      "Bad Request: wrong file identifier/HTTP URL specified",
      "Bad Request: failed to get HTTP URL content",
      "Bad Request: wrong type of the web page",
      "Bad Request: PHOTO_INVALID_DIMENSIONS",
    ]) {
      expect(isTelegramMediaRejected(new Error(message))).toBe(true);
    }
  });

  it("does not swallow retry-after, blocks, or unrelated failures", () => {
    for (const message of [
      "Too Many Requests: retry after 37",
      "Forbidden: bot was blocked by the user",
      "Bad Request: message is not modified",
      "socket hang up",
    ]) {
      expect(isTelegramMediaRejected(new Error(message))).toBe(false);
    }
  });
});
