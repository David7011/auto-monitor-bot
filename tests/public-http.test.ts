import { describe, expect, it } from "vitest";
import { isPublicIpAddress } from "../apps/worker/src/lib/public-http.js";
import { readResponseBuffer, ResponseTooLargeError } from "../apps/worker/src/lib/response-body.js";

describe("public HTTP safety", () => {
  it("rejects local, private, link-local and documentation addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "100::1",
      "2001:2::1",
      "2001:20::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) expect(isPublicIpAddress(address), address).toBe(false);
    expect(isPublicIpAddress("1.1.1.1")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("stops reading a chunked response as soon as the hard limit is crossed", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    }));
    await expect(readResponseBuffer(response, 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("returns a response that stays below the hard limit", async () => {
    const response = new Response("safe body");
    await expect(readResponseBuffer(response, 32)).resolves.toEqual(Buffer.from("safe body"));
  });
});
