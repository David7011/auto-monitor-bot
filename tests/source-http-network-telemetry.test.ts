import diagnosticsChannel from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { takeSourceNetworkTelemetry } from "../apps/worker/src/collectors/source-http-network-telemetry.js";

describe("source HTTP network telemetry", () => {
  it("correlates an OLX request without retaining URL or header data", () => {
    const requestId = `network-test-${Date.now()}`;
    const request = {
      origin: "https://www.olx.ua",
      headers: ["x-request-id", requestId],
    };
    const socket = {};
    publish("undici:request:create", { request });
    publish("undici:client:beforeConnect", {
      connectParams: { protocol: "https:", host: "www.olx.ua" },
    });
    publish("undici:client:connected", {
      connectParams: { protocol: "https:", host: "www.olx.ua" },
      socket,
    });
    publish("undici:client:sendHeaders", { request, socket });
    publish("undici:request:headers", { request });
    publish("undici:request:bodyChunkReceived", { request, chunk: Buffer.alloc(123) });
    publish("undici:request:trailers", { request });

    const result = takeSourceNetworkTelemetry(requestId);
    expect(result).toMatchObject({ connectionReused: false, responseBytes: 123 });
    expect(result?.dispatcherWaitMs).toBeGreaterThanOrEqual(0);
    expect(result?.connectionSetupMs).toBeGreaterThanOrEqual(0);
    expect(result?.wireTtfbMs).toBeGreaterThanOrEqual(0);
    expect(result?.downloadMs).toBeGreaterThanOrEqual(0);
    expect(result).not.toHaveProperty("url");
    expect(result).not.toHaveProperty("headers");

    const secondId = `${requestId}-reused`;
    const secondRequest = {
      origin: "https://www.olx.ua",
      headers: `accept: application/json\r\nx-request-id: ${secondId}\r\n`,
    };
    publish("undici:request:create", { request: secondRequest });
    publish("undici:client:sendHeaders", { request: secondRequest, socket });
    publish("undici:request:headers", { request: secondRequest });
    publish("undici:request:trailers", { request: secondRequest });
    expect(takeSourceNetworkTelemetry(secondId)).toMatchObject({
      connectionReused: true,
      connectionSetupMs: 0,
    });
  });

  it("ignores non-OLX origins", () => {
    const requestId = `ignored-network-test-${Date.now()}`;
    const request = {
      origin: "https://example.com",
      headers: ["x-request-id", requestId],
    };
    publish("undici:request:create", { request });
    publish("undici:request:trailers", { request });
    expect(takeSourceNetworkTelemetry(requestId)).toBeUndefined();
  });
});

function publish(name: string, message: Record<string, unknown>): void {
  diagnosticsChannel.channel(name).publish(message);
}
