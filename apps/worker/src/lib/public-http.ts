import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import { readResponseBuffer } from "./response-body.js";

const MAX_REDIRECTS = 3;

export type PublicBufferResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  body: Buffer;
  finalUrl: string;
};

export async function fetchPublicBuffer(
  urlValue: string,
  options: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxBytes: number;
    maxRedirects?: number;
  },
): Promise<PublicBufferResponse> {
  let current = parsePublicUrl(urlValue);
  const maxRedirects = Math.max(0, Math.min(MAX_REDIRECTS, options.maxRedirects ?? MAX_REDIRECTS));

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const addresses = await resolvePublicAddresses(current.hostname);
    const pinned = addresses[0]!;
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _lookupOptions, callback) => callback(null, pinned.address, pinned.family),
      },
    });
    try {
      const response = await fetch(current, {
        headers: options.headers,
        redirect: "manual",
        signal: options.signal,
        dispatcher,
      });

      if (isRedirect(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect HTTP ${response.status} did not include Location`);
        if (redirectCount >= maxRedirects) throw new Error("Too many HTTP redirects");
        current = parsePublicUrl(new URL(location, current).toString());
        continue;
      }

      const body = await readResponseBuffer(response as unknown as Response, options.maxBytes);
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers as unknown as Headers,
        body,
        finalUrl: current.toString(),
      };
    } finally {
      await dispatcher.close();
    }
  }

  throw new Error("Too many HTTP redirects");
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    const [a = -1, b = -1, c = -1] = octets;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    // IANA IPv4 special-purpose ranges that are not safe public fetch targets.
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false;
    return true;
  }
  if (version === 6) {
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
    if (normalized.startsWith("ff")) return false;
    if (normalized.startsWith("100:")) return false;
    if (normalized.startsWith("2001:2:")) return false;
    if (/^2001:(?:2[0-9a-f]|3[0-9a-f]):/u.test(normalized)) return false;
    if (normalized.startsWith("2001:db8:")) return false;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    return mapped ? isPublicIpAddress(mapped) : true;
  }
  return false;
}

function parsePublicUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("Only credential-free HTTP(S) URLs are allowed");
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Local network URLs are not allowed");
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) throw new Error("Private IP addresses are not allowed");
  return url;
}

async function resolvePublicAddresses(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => !isPublicIpAddress(item.address))) {
    throw new Error("Hostname resolves to a private or reserved address");
  }
  return addresses.map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
