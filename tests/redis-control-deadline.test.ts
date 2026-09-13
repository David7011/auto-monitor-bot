import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createControlRedis, bullConnection } from "../apps/worker/src/lib/queues.js";

describe("bounded control Redis versus blocking consumers", () => {
  it("rejects GET/SET/EVAL on a real TCP blackhole within the command deadline", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      socket.on("data", (chunk) => {
        const input = chunk.toString().toLowerCase();
        // Complete connection negotiation; only application commands blackhole.
        if (input.includes("\r\ninfo\r\n")) {
          const info = "redis_version:8.8.0\r\n";
          socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
        } else if (input.includes("\r\nclient\r\n")) {
          const commands = input.match(/\r\nclient\r\n/gu)?.length ?? 1;
          socket.write("+OK\r\n".repeat(commands));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test TCP address");
    const connection = createControlRedis(`redis://127.0.0.1:${address.port}`);
    try {
      await connection.connect();
      const started = Date.now();
      const results = await Promise.allSettled([
        connection.get("test-lock"), connection.set("test-lock", "test-owner", "PX", 1000, "NX"), connection.eval("return 1", 0),
      ]);
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(connection.options).toMatchObject({ maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 2000 });
      expect(bullConnection).toMatchObject({ maxRetriesPerRequest: null, enableOfflineQueue: true });
    } finally {
      connection.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
