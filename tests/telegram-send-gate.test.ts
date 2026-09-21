import { describe, expect, it } from "vitest";
import {
  TelegramSendGate,
  telegramRateGateKey,
  type TelegramRateGateRedis,
} from "../apps/worker/src/modules/telegram-send-gate.js";

describe("Telegram send gate", () => {
  it("spaces concurrent send starts without serializing their network requests", async () => {
    let now = 1_000;
    const gate = new TelegramSendGate(1_100, {
      redis: fakeTelegramRedis(() => now),
      key: "telegram:test",
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; await Promise.resolve(); },
    });

    const starts = [await gate.waitForSlot().then(() => now)];
    starts.push(await gate.waitForSlot().then(() => now));
    starts.push(await gate.waitForSlot().then(() => now));

    const ordered = [...starts].sort((left, right) => left - right);
    expect(ordered).toHaveLength(3);
    expect(ordered[1]! - ordered[0]!).toBeGreaterThanOrEqual(1_100);
    expect(ordered[2]! - ordered[1]!).toBeGreaterThanOrEqual(1_100);
  });

  it("lets a fresh realtime send overtake queued background edits", async () => {
    let now = 1_000;
    const gate = new TelegramSendGate(1_100, {
      redis: fakeTelegramRedis(() => now),
      key: "telegram:test",
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; await Promise.resolve(); },
    });

    await gate.waitForSlot(0);
    const starts: string[] = [];
    const background = gate.waitForSlot(20).then(() => starts.push(`background:${now}`));
    const realtime = gate.waitForSlot(0).then(() => starts.push(`realtime:${now}`));

    await Promise.all([realtime, background]);

    expect(starts.map((value) => value.split(":", 1)[0])).toEqual(["realtime", "background"]);
  });

  it("sends the newest listing first among waiters in the same lane", async () => {
    let now = 1_000;
    const gate = new TelegramSendGate(1_100, {
      redis: fakeTelegramRedis(() => now),
      key: "telegram:test",
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; await Promise.resolve(); },
    });

    await gate.waitForSlot(0);
    const starts: string[] = [];
    const older = gate.waitForSlot(0, -1_000).then(() => starts.push(`older:${now}`));
    const newer = gate.waitForSlot(0, -2_000).then(() => starts.push(`newer:${now}`));

    await Promise.all([newer, older]);

    expect(starts.map((value) => value.split(":", 1)[0])).toEqual(["newer", "older"]);
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

  it("gives a cross-process realtime waiter the next slot before background work", async () => {
    let now = 1_000;
    const redis = fakeTelegramRedis(() => now);
    const dependencies = () => ({
      redis,
      key: "telegram:shared-priority",
      now: () => now,
      sleep: async (milliseconds: number) => { now += milliseconds; await Promise.resolve(); },
    });
    const apiGate = new TelegramSendGate(1_100, dependencies());
    const workerGate = new TelegramSendGate(1_100, dependencies());
    await apiGate.waitForSlot(0);

    const starts: string[] = [];
    const background = apiGate.waitForSlot(20).then(() => starts.push("background"));
    const realtime = workerGate.waitForSlot(0).then(() => starts.push("realtime"));
    await Promise.all([background, realtime]);

    expect(starts).toEqual(["realtime", "background"]);
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

  it("rechecks a cooldown extended by another process while already waiting", async () => {
    let now = 1_000;
    const redis = fakeTelegramRedis(() => now);
    const other = new TelegramSendGate(1_100, { redis, key: "telegram:shared", now: () => now });
    await other.waitForSlot();
    const sleeps: number[] = [];
    const waiting = new TelegramSendGate(1_100, {
      redis, key: "telegram:shared", now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        if (sleeps.length === 1) await other.deferFor(5_000);
        now += milliseconds;
      },
    });
    await waiting.waitForSlot();
    expect(now).toBeGreaterThanOrEqual(6_000);
    expect(sleeps).toEqual([1_100, 3_900]);
  });

  it("uses bot id and chat id without putting the bot secret in Redis keys", () => {
    const key = telegramRateGateKey("123456:super-secret", "-100987");
    expect(key).toBe("amb:telegram:rate:v1:123456:-100987");
    expect(key).not.toContain("super-secret");
  });

  it("fails closed if Redis disappears during an already waiting send", async () => {
    let calls = 0;
    const gate = new TelegramSendGate(1_100, {
      key: "telegram:shared",
      redis: { eval: async () => {
        if (calls++ === 0) return 250;
        throw new Error("redis disconnected during cooldown");
      } },
      sleep: async () => {},
    });
    await expect(gate.waitForSlot()).rejects.toThrow("redis disconnected during cooldown");
  });

  it("does not shorten an existing cooldown or prebook overlapping future starts", async () => {
    let now = 1_000;
    const redis = fakeTelegramRedis(() => now);
    const dependencies = { redis, key: "telegram:shared", now: () => now,
      sleep: async (milliseconds: number) => { now += milliseconds; } };
    const first = new TelegramSendGate(1_100, dependencies);
    const second = new TelegramSendGate(1_100, dependencies);
    await first.deferFor(5_000);
    await second.deferFor(100);
    await second.waitForSlot();
    expect(now).toBe(6_000);
    await first.waitForSlot();
    expect(now).toBe(7_100);
  });
});

function fakeTelegramRedis(now: () => number): TelegramRateGateRedis {
  let nextSlotAt = 0;
  const waiterLeases = new Map<string, number>();
  return {
    eval: async (script, numberOfKeys, ...args) => {
      if (script.includes("defer-v1")) {
        const delay = Math.max(0, Number(args[numberOfKeys]));
        nextSlotAt = Math.max(nextSlotAt, now() + delay);
        return Math.max(0, nextSlotAt - now());
      }
      const interval = Math.max(0, Number(args[numberOfKeys]));
      const member = String(args[numberOfKeys + 1]);
      const lease = Math.max(5_000, Number(args[numberOfKeys + 2]));
      for (const [queuedMember, expiresAt] of waiterLeases) {
        if (expiresAt <= now()) waiterLeases.delete(queuedMember);
      }
      waiterLeases.set(member, now() + lease);
      const head = [...waiterLeases.keys()].sort()[0];
      if (head !== member) return nextSlotAt > now() ? nextSlotAt - now() : 25;
      if (nextSlotAt > now()) return nextSlotAt - now();
      nextSlotAt = now() + interval;
      waiterLeases.delete(member);
      return 0;
    },
  };
}
