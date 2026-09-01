import { describe, expect, it } from "vitest";
import { collectProgressively } from "../apps/worker/src/modules/progressive-results.js";

describe("progressive direct results", () => {
  it("hands off the first completed response without waiting for other targets", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const handedOff: string[] = [];

    const batch = collectProgressively(
      [first, second],
      (target) => target.promise,
      async (result) => {
        handedOff.push(result);
      },
    );

    first.resolve("first-city");
    await waitUntil(() => handedOff.length === 1);
    expect(handedOff).toEqual(["first-city"]);

    second.resolve("second-city");
    await expect(batch).resolves.toEqual(["first-city", "second-city"]);
    expect(handedOff).toEqual(["first-city", "second-city"]);
  });

  it("preserves target order even when responses finish out of order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const handedOff: string[] = [];
    const batch = collectProgressively(
      [first, second],
      (target) => target.promise,
      async (result) => { handedOff.push(result); },
    );

    second.resolve("second-city");
    await waitUntil(() => handedOff.length === 1);
    expect(handedOff).toEqual(["second-city"]);
    first.resolve("first-city");

    await expect(batch).resolves.toEqual(["first-city", "second-city"]);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
