import { describe, expect, it } from "vitest";
import {
  TelegramSendGate,
  telegramRateGateKey,
  type TelegramRateGateRedis,
} from "../apps/worker/src/modules/telegram-send-gate.js";

describe("Telegram send gate", () => {
  it("spaces concurrent send starts without serializing their network requests", async () => {
    let now = 1_000;
    const sleeps: Array<{ milliseconds: number; release: () => void }> = [];
    const gate = new TelegramSendGate(1_100, {
      redis: fakeTelegramRedis(() => now),
      key: "telegram:test",
      now: () => now,
      sleep: (milliseconds) => new Promise<void>((resolve) => {
        sleeps.push({
          milliseconds,
          release: () => {
            now += milliseconds;
            resolve();
          },
        });
      }),
    });

    const starts = [await gate.waitForSlot().then(() => now)];
    const second = gate.waitForSlot().then(() => now);
    const third = gate.waitForSlot().then(() => now);
    expect(sleeps.map((entry) => entry.milliseconds)).toEqual([1_100]);
    sleeps.shift()?.release();
    starts.push(await second);
    await Promise.resolve();
    expect(sleeps.map((entry) => entry.milliseconds)).toEqual([1_100]);
    sleeps.shift()?.release();
    starts.push(await third);

    expect(starts).toEqual([1_000, 2_100, 3_200]);
  });

  it("lets a fresh realtime send overtake queued background edits", async () => {
    let now = 1_000;
    const sleepers: Array<() => void> = [];
    const gate = new TelegramSendGate(1_100, {
      redis: fakeTelegramRedis(() => now),
      key: "telegram:test",
      now: () => now,
      sleep: (milliseconds) => new Promise<void>((resolve) => {
        sleepers.push(() => {
          now += milliseconds;
          resolve();
        });
      }),
    });

    await gate.waitForSlot(0);
    const starts: string[] = [];
    const background = gate.waitForSlot(20).then(() => starts.push(`background:${now}`));
    const realtime = gate.waitForSlot(0).then(() => starts.push(`realtime:${now}`));

    await Promise.resolve();
    expect(sleepers).toHaveLength(1);
    sleepers.shift()?.();
    await realtime;
    await Promise.resolve();
    expect(sleepers).toHaveLength(1);
    sleepers.shift()?.();
    await background;

    expect(starts).toEqual(["realtime:2100", "background:3200"]);
  });

  it("sends the newest listing first among waiters in the same lane", async () => {
    let now = 1_000;
    const sleepers: Array<() => void> = [];
    const gate = new TelegramSendGate(1_100, {
      redis: fakeTelegramRedis(() => now),
      key: "telegram:test",
      now: () => now,
      sleep: (milliseconds) => new Promise<void>((resolve) => {
        sleepers.push(() => {
          now += milliseconds;
          resolve();
        });
      }),
    });

    await gate.waitForSlot(0);
    const starts: string[] = [];
    const older = gate.waitForSlot(0, -1_000).then(() => starts.push(`older:${now}`));
    const newer = gate.waitForSlot(0, -2_000).then(() => starts.push(`newer:${now}`));

    await Promise.resolve();
    sleepers.shift()?.();
    await newer;
    await Promise.resolve();
    sleepers.shift()?.();
    await older;

    expect(starts).toEqual(["newer:2100", "older:3200"]);
  });

  it("spaces independent gate instances through one Redis timeline", async () => {
    let now = 1_000;
    const redis = fakeTelegramRedis(() => now);
    const sleepers: Array<{ milliseconds: number; release: () => void }> = [];
    const dependencies = () => ({
      redis,
      key: "telegram:shared",
      now: () => now,
      sleep: (milliseconds: number) => new Promise<void>((resolve) => {
        sleepers.push({
          milliseconds,
          release: () => {
            now += milliseconds;
            resolve();
          },
        });
      }),
    });
    const apiGate = new TelegramSendGate(1_100, dependencies());
    const workerGate = new TelegramSendGate(1_100, dependencies());

    const starts = [await apiGate.waitForSlot().then(() => now)];
    const worker = workerGate.waitForSlot().then(() => starts.push(now));
    await Promise.resolve();
    expect(sleepers.map((entry) => entry.milliseconds)).toEqual([1_100]);
    sleepers.shift()?.release();
    await worker;

    expect(starts).toEqual([1_000, 2_100]);
  });

  it("shares Telegram retry_after cooldown across instances", async () => {
    let now = 1_000;
    const redis = fakeTelegramRedis(() => now);
    const first = new TelegramSendGate(1_100, { redis, key: "telegram:shared", now: () => now });
    const sleeps: number[] = [];
    const second = new TelegramSendGate(1_100, {
      redis,
      key: "telegram:shared",
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await first.waitForSlot();
    await first.deferFor(5_000);
    await second.waitForSlot();

    expect(sleeps).toEqual([5_000]);
    expect(now).toBe(6_000);
  });

  it("fails closed when the shared Redis gate is unavailable", async () => {
    const gate = new TelegramSendGate(1_100, {
      key: "telegram:shared",
      redis: { eval: async () => { throw new Error("redis unavailable"); } },
    });

    await expect(gate.waitForSlot()).rejects.toThrow("redis unavailable");
  });

  it("uses bot id and chat id without putting the bot secret in Redis keys", () => {
    const key = telegramRateGateKey("123456:super-secret", "-100987");
    expect(key).toBe("amb:telegram:rate:v1:123456:-100987");
    expect(key).not.toContain("super-secret");
  });
});

function fakeTelegramRedis(now: () => number): TelegramRateGateRedis {
  let nextSlotAt = 0;
  return {
    eval: async (script, _numberOfKeys, _key, milliseconds) => {
      const delay = Math.max(0, Number(milliseconds));
      if (script.includes("defer-v1")) {
        nextSlotAt = Math.max(nextSlotAt, now() + delay);
        return Math.max(0, nextSlotAt - now());
      }
      const slot = Math.max(now(), nextSlotAt);
      nextSlotAt = slot + delay;
      return slot - now();
    },
  };
}
