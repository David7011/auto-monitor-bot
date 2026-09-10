import diagnosticsChannel from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

export type SourceNetworkTelemetry = {
  dispatcherWaitMs?: number;
  connectionSetupMs?: number;
  connectionReused?: boolean;
  wireTtfbMs?: number;
  downloadMs?: number;
  responseBytes?: number;
};

type RequestLike = { origin?: unknown; headers?: unknown };
type SocketLike = object;
type Trace = SourceNetworkTelemetry & {
  requestId: string;
  createdAt: number;
  sentAt?: number;
  headersAt?: number;
};

const requests = new WeakMap<object, Trace>();
const completed = new Map<string, SourceNetworkTelemetry>();
const pendingConnects = new Map<string, number[]>();
const sockets = new WeakMap<SocketLike, { setupMs: number; used: boolean }>();
const MAX_COMPLETED = 1_000;

subscribe("undici:request:create", (message) => {
  const request = objectValue(message.request) as RequestLike | undefined;
  const requestId = requestIdFromHeaders(request?.headers);
  if (!request || !requestId || !isObservedOrigin(request.origin)) return;
  requests.set(request as object, { requestId, createdAt: performance.now(), responseBytes: 0 });
});

subscribe("undici:client:beforeConnect", (message) => {
  const origin = connectOrigin(message.connectParams);
  if (!isObservedOrigin(origin)) return;
  const queue = pendingConnects.get(origin) ?? [];
  queue.push(performance.now());
  pendingConnects.set(origin, queue);
});

subscribe("undici:client:connected", (message) => {
  const origin = connectOrigin(message.connectParams);
  const socket = objectValue(message.socket);
  if (!socket || !isObservedOrigin(origin)) return;
  const queue = pendingConnects.get(origin);
  const startedAt = queue?.shift();
  if (queue?.length === 0) pendingConnects.delete(origin);
  sockets.set(socket, { setupMs: startedAt == null ? 0 : elapsed(startedAt), used: false });
});

subscribe("undici:client:connectError", (message) => {
  const origin = connectOrigin(message.connectParams);
  const queue = pendingConnects.get(origin);
  queue?.shift();
  if (queue?.length === 0) pendingConnects.delete(origin);
});

subscribe("undici:client:sendHeaders", (message) => {
  const request = objectValue(message.request);
  const socket = objectValue(message.socket);
  if (!request) return;
  const trace = requests.get(request);
  if (!trace) return;
  trace.sentAt = performance.now();
  trace.dispatcherWaitMs = rounded(trace.sentAt - trace.createdAt);
  const connection = socket ? sockets.get(socket) : undefined;
  if (connection) {
    trace.connectionReused = connection.used;
    trace.connectionSetupMs = connection.used ? 0 : rounded(connection.setupMs);
    connection.used = true;
  }
});

subscribe("undici:request:headers", (message) => {
  const request = objectValue(message.request);
  if (!request) return;
  const trace = requests.get(request);
  if (!trace) return;
  trace.headersAt = performance.now();
  if (trace.sentAt != null) trace.wireTtfbMs = rounded(trace.headersAt - trace.sentAt);
});

subscribe("undici:request:bodyChunkReceived", (message) => {
  const request = objectValue(message.request);
  if (!request) return;
  const trace = requests.get(request);
  if (!trace) return;
  const chunk = message.chunk;
  const bytes = chunk && typeof chunk === "object" && "byteLength" in chunk
    ? Number((chunk as { byteLength: unknown }).byteLength)
    : 0;
  trace.responseBytes = (trace.responseBytes ?? 0) + (Number.isFinite(bytes) ? bytes : 0);
});

subscribe("undici:request:trailers", (message) => finish(message.request));
subscribe("undici:request:error", (message) => finish(message.request));

export function takeSourceNetworkTelemetry(requestId: string): SourceNetworkTelemetry | undefined {
  const value = completed.get(requestId);
  completed.delete(requestId);
  return value;
}

function finish(value: unknown): void {
  const request = objectValue(value);
  if (!request) return;
  const trace = requests.get(request);
  if (!trace) return;
  requests.delete(request);
  if (trace.headersAt != null) trace.downloadMs = rounded(elapsed(trace.headersAt));
  const { requestId, createdAt: _createdAt, sentAt: _sentAt, headersAt: _headersAt, ...telemetry } = trace;
  if (completed.size >= MAX_COMPLETED) completed.delete(completed.keys().next().value as string);
  completed.set(requestId, telemetry);
}

function subscribe(name: string, handler: (message: Record<string, unknown>) => void): void {
  diagnosticsChannel.channel(name).subscribe((message) => {
    try {
      if (message && typeof message === "object") handler(message as Record<string, unknown>);
    } catch {
      // Telemetry must never affect source traffic.
    }
  });
}

function requestIdFromHeaders(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /(?:^|\r?\n)x-request-id:\s*([^\r\n]+)/iu.exec(value)?.[1]?.trim();
  }
  if (!Array.isArray(value)) return undefined;
  for (let index = 0; index < value.length - 1; index += 2) {
    if (String(value[index]).toLowerCase() === "x-request-id") return String(value[index + 1]).trim();
  }
  return undefined;
}

function connectOrigin(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const params = value as { protocol?: unknown; host?: unknown; hostname?: unknown; port?: unknown };
  const protocol = String(params.protocol ?? "https:");
  const host = String(params.host ?? params.hostname ?? "");
  return host ? `${protocol}//${host}` : "";
}

function isObservedOrigin(value: unknown): boolean {
  try {
    const hostname = new URL(String(value)).hostname.toLowerCase();
    return hostname === "olx.ua" || hostname.endsWith(".olx.ua");
  } catch {
    return false;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function elapsed(startedAt: number): number {
  return performance.now() - startedAt;
}

function rounded(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}
