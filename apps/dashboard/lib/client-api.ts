const BFF_BASE_URL = "/api/backend";

export class DashboardApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, message: string, options: { code?: string; details?: unknown; requestId?: string } = {}) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${BFF_BASE_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (err) {
    throw new DashboardApiError(0, "Не удалось связаться с backend-proxy dashboard", {
      code: "BFF_NETWORK_ERROR",
      details: err instanceof Error ? err.message : String(err),
    });
  }

  if (!response.ok) {
    throw await toDashboardError(response);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function toDashboardError(response: Response): Promise<DashboardApiError> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  const bodyObject = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof bodyObject.code === "string" ? bodyObject.code : statusCode(response.status);
  const message =
    typeof bodyObject.error === "string"
      ? bodyObject.error
      : typeof bodyObject.message === "string"
        ? bodyObject.message
        : defaultMessage(response.status);

  return new DashboardApiError(response.status, message, {
    code,
    details: bodyObject.details ?? body,
    requestId: typeof bodyObject.requestId === "string" ? bodyObject.requestId : requestId,
  });
}

function statusCode(status: number): string {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "BFF_UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "FIELD_VALIDATION_ERROR";
    case 429:
      return "RATE_LIMITED";
    case 500:
      return "BACKEND_ERROR";
    case 502:
      return "INTERNAL_API_UNAVAILABLE";
    case 504:
      return "INTERNAL_API_TIMEOUT";
    default:
      return `HTTP_${status}`;
  }
}

function defaultMessage(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return "Данные запроса не прошли проверку";
    case 401:
      return "Авторизация backend для dashboard настроена неверно";
    case 403:
      return "Запрос запрещен";
    case 404:
      return "Ресурс не найден";
    case 409:
      return "Запрос конфликтует с текущим состоянием системы";
    case 429:
      return "Слишком много запросов";
    case 502:
      return "Внутренний API недоступен";
    case 504:
      return "Внутренний API не ответил вовремя";
    default:
      return `HTTP ${status}`;
  }
}

export const clientApi = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function dashboardErrorMessage(err: unknown): string {
  if (err instanceof DashboardApiError) {
    if (err.code === "BFF_CONFIG_MISSING_API_URL") {
      return "Локальная панель не подключена к API. Проверь, что сервисы Auto Monitor Bot запущены на ноутбуке.";
    }
    if (err.code === "BFF_CONFIG_MISSING_TOKEN") {
      return "Локальная панель не знает LOCAL_API_TOKEN. Проверь файл .env и перезапусти проект.";
    }
    return `${err.message}${err.code ? ` (${err.code})` : ""}${err.requestId ? ` · request ${err.requestId}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}
