import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getBackendProxyConfig, safeProxyResponseHeaders } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const textEncoder = new TextEncoder();

async function handler(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const config = getBackendProxyConfig(requestId);
  if (!config.ok) {
    return NextResponse.json(config.body, { status: config.status, headers: { "x-request-id": requestId } });
  }

  const params = await context.params;
  const path = (params.path ?? []).map(encodeURIComponent).join("/");
  const target = new URL(`${config.internalApiUrl}/${path}`);
  target.search = request.nextUrl.search;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${config.localApiToken}`);
    headers.set("x-request-id", requestId);

    const body = await backendRequestBody(request, config.maxBodyBytes);
    if (body != null) {
      headers.set("content-type", request.headers.get("content-type")?.includes("json") ? request.headers.get("content-type")! : "application/json");
    }
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });

    const responseHeaders = safeProxyResponseHeaders(response.headers);
    responseHeaders.set("x-request-id", requestId);
    if ([204, 205, 304].includes(response.status)) {
      return new NextResponse(null, { status: response.status, headers: responseHeaders });
    }
    const responseBody = await response.arrayBuffer();
    return new NextResponse(responseBody, { status: response.status, headers: responseHeaders });
  } catch (err) {
    if (err instanceof BackendProxyBodyError) {
      return NextResponse.json(
        { error: err.message, code: err.code, requestId },
        { status: err.status, headers: { "x-request-id": requestId } },
      );
    }
    const aborted = err instanceof Error && err.name === "AbortError";
    return NextResponse.json(
      {
        error: aborted ? "Internal API request timed out" : "Internal API is unavailable",
        code: aborted ? "INTERNAL_API_TIMEOUT" : "INTERNAL_API_UNAVAILABLE",
        requestId,
      },
      { status: aborted ? 504 : 502, headers: { "x-request-id": requestId } },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;

async function backendRequestBody(request: NextRequest, maxBodyBytes: number): Promise<string | undefined> {
  if (BODYLESS_METHODS.has(request.method)) return undefined;
  if (!hasRequestBody(request)) return "{}";
  const contentLength = request.headers.get("content-length");
  const contentLengthBytes = contentLength == null ? undefined : Number(contentLength);
  if (contentLengthBytes != null && Number.isFinite(contentLengthBytes) && contentLengthBytes > maxBodyBytes) {
    throw new BackendProxyBodyError(413, "BFF_BODY_TOO_LARGE", `Тело запроса dashboard больше ${maxBodyBytes} байт`);
  }
  const text = await request.text();
  if (textEncoder.encode(text).byteLength > maxBodyBytes) {
    throw new BackendProxyBodyError(413, "BFF_BODY_TOO_LARGE", `Тело запроса dashboard больше ${maxBodyBytes} байт`);
  }
  return text.trim() ? text : "{}";
}

function hasRequestBody(request: NextRequest): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength != null) {
    const contentLengthBytes = Number(contentLength);
    return Number.isFinite(contentLengthBytes) ? contentLengthBytes > 0 : true;
  }
  return request.headers.has("transfer-encoding");
}

class BackendProxyBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendProxyBodyError";
  }
}
