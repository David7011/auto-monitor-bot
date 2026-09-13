import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsSourceHttp, windowsResponseTiming } from "../apps/worker/src/lib/windows-source-http.js";

const clients: WindowsSourceHttp[] = [];
const servers: Server[] = [];
afterEach(async () => {
  clients.splice(0).forEach(client => client.close());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform !== "win32")("Windows native HTTP transport", () => {
  async function fixture() {
    vi.stubEnv("AMB_PIPELINE_INTEGRATION_TEST", "1");
    const server = createServer((request, response) => {
      if (request.url === "/hang") return;
      if (request.url === "/large") { response.writeHead(200, { "content-type": "text/html" }); response.end("x".repeat(4096)); return; }
      if (request.url === "/redirect") { response.writeHead(302, { location: "https://other.invalid/" }); response.end(); return; }
      response.writeHead(request.url === "/limited" ? 429 : request.url === "/denied" ? 403 : 200, { "content-type": "text/html; charset=utf-8", "retry-after": "120", "cf-mitigated": "challenge" });
      response.end("<h1>Дніпро — 429 не CAPTCHA</h1>");
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const client = new WindowsSourceHttp(true);
    clients.push(client);
    return { client, url: `http://127.0.0.1:${address.port}` };
  }

  it("preserves UTF8, response status, protection headers and actual stage timestamps across persistent requests", async () => {
    const { client, url } = await fixture();
    for (const [suffix, status] of [["/", 200], ["/denied", 403], ["/limited", 429]] as const) {
      const before = Date.now();
      const response = await client.fetch(url + suffix, { method: "GET" }, 10000, 5000);
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe("120");
      expect(response.headers.get("cf-mitigated")).toBe("challenge");
      expect(await response.text()).toContain("Дніпро");
      const timing = windowsResponseTiming.get(response)!;
      expect(timing.firstByteAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(timing.bodyReceivedAt.getTime()).toBeGreaterThanOrEqual(timing.firstByteAt.getTime());
    }
  }, 15000);

  it("bounds chunked bodies, never follows redirects and rejects unsupported destinations", async () => {
    const { client, url } = await fixture();
    const response = await client.fetch(url + "/large", {}, 128, 5000);
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(128);
    expect(await response.text()).toBe("");
    expect((await client.fetch(url + "/redirect", {}, 128, 5000)).status).toBe(302);
    await expect(client.fetch("https://other.invalid/", {}, 128, 5000)).rejects.toThrow("Unsupported");
  }, 15000);

  it("kills an aborted request and recovers the next request in a fresh helper", async () => {
    const { client, url } = await fixture();
    await client.fetch(url, {}, 10000, 5000);
    const controller = new AbortController();
    const pending = client.fetch(url + "/hang", { signal: controller.signal }, 10000, 5000);
    controller.abort(new Error("lease lost"));
    await expect(pending).rejects.toThrow("lease lost");
    expect((await client.fetch(url, {}, 10000, 5000)).status).toBe(200);
  }, 15000);
});
