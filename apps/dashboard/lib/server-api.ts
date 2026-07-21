import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const LOCAL_INTERNAL_API_URL = "http://127.0.0.1:4000";
let rootEnvLoaded = false;

export type BackendProxyConfig =
  | { ok: true; internalApiUrl: string; localApiToken: string; timeoutMs: number; maxBodyBytes: number }
  | { ok: false; status: number; body: { error: string; code: string; requestId: string } };

export function getBackendProxyConfig(requestId: string): BackendProxyConfig {
  loadRootEnvOnce();

  const internalApiUrl = resolveInternalApiUrl();
  const localApiToken = (process.env.LOCAL_API_TOKEN ?? "").trim();
  const timeoutMs = Number(process.env.INTERNAL_API_TIMEOUT_MS ?? 15000);
  const maxBodyBytes = Number(process.env.BFF_MAX_BODY_BYTES ?? 1_000_000);

  if (!internalApiUrl) {
    return {
      ok: false,
      status: 503,
      body: { error: "Backend dashboard не подключен: отсутствует INTERNAL_API_URL", code: "BFF_CONFIG_MISSING_API_URL", requestId },
    };
  }

  if (!localApiToken) {
    return {
      ok: false,
      status: 503,
      body: { error: "Backend dashboard не подключен: отсутствует LOCAL_API_TOKEN", code: "BFF_CONFIG_MISSING_TOKEN", requestId },
    };
  }

  return {
    ok: true,
    internalApiUrl: internalApiUrl.replace(/\/$/u, ""),
    localApiToken,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
    maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 1_000_000,
  };
}

export function safeProxyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  const contentType = source.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const requestId = source.get("x-request-id");
  if (requestId) headers.set("x-request-id", requestId);
  return headers;
}

function loadRootEnvOnce(): void {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;

  for (const envPath of candidateEnvPaths()) {
    if (!existsSync(envPath)) continue;
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      const normalizedKey = key.trim();
      if (!normalizedKey || process.env[normalizedKey] != null) continue;
      process.env[normalizedKey] = rest.join("=").trim().replace(/^["']|["']$/gu, "");
    }
    return;
  }
}

function resolveInternalApiUrl(): string {
  const explicitUrl = (process.env.INTERNAL_API_URL ?? "").trim();
  if (explicitUrl) return explicitUrl;
  return LOCAL_INTERNAL_API_URL;
}

function candidateEnvPaths(): string[] {
  return [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", "..", ".env"),
  ];
}
