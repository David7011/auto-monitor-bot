import { Pool, type PoolClient, type PoolConfig } from "pg";

const DEFAULT_POOL_MAX = 6;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_CONNECT_RETRIES = 2;
const DEFAULT_RETRY_DELAYS_MS = [25, 75] as const;

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: boolean | Error) => void,
) => void;

export type DatabasePoolDiagnostics = {
  applicationName: string;
  max: number;
  total: number;
  idle: number;
  waiting: number;
  connectRetries: number;
  recoveredConnects: number;
  exhaustedConnects: number;
  lastRetryAt: string | null;
  lastRetryReason: string | null;
};

type RetryHooks = {
  maxRetries?: number;
  delaysMs?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (error: unknown, retryNumber: number) => void;
};

export async function closeDatabaseResources(
  disconnectPrisma: () => Promise<void>,
  endPool: () => Promise<void>,
): Promise<void> {
  let disconnectError: unknown;
  try {
    await disconnectPrisma();
  } catch (error) {
    disconnectError = error;
  }

  try {
    await endPool();
  } catch (poolError) {
    if (disconnectError) {
      throw new AggregateError(
        [disconnectError, poolError],
        "Failed to close Prisma and its PostgreSQL pool",
        { cause: poolError },
      );
    }
    throw poolError;
  }
  if (disconnectError) throw disconnectError;
}

export function databasePoolConfig(
  connectionString: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  return {
    connectionString,
    application_name: databaseApplicationName(environment, process.argv),
    max: boundedInteger(environment.DATABASE_POOL_MAX, DEFAULT_POOL_MAX, 1, 20),
    min: 1,
    // This laptop process model benefits from warm connections. Disabling idle
    // eviction avoids both PostgreSQL's Windows backend-creation failure and
    // the handshake cost on the next realtime listing event.
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: boundedInteger(
      environment.DATABASE_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      250,
      30_000,
    ),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    allowExitOnIdle: false,
    maxUses: Number.POSITIVE_INFINITY,
    maxLifetimeSeconds: 0,
  };
}

export function isTransientDatabaseConnectError(error: unknown): boolean {
  const values = errorChain(error);
  const codes = new Set(values.map((entry) => entry.code).filter(Boolean));
  if ([
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "57P03", // cannot_connect_now
    "53200", // out_of_memory (the Windows shared-memory reservation path)
    "53300", // too_many_connections
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "08P01",
  ].some((code) => codes.has(code))) {
    return true;
  }

  const message = values.map((entry) => entry.message).join("\n").toLowerCase();
  return [
    "error code 487",
    "could not reserve shared memory region",
    "could not fork new process for connection",
    "connection terminated unexpectedly",
    "server closed the connection unexpectedly",
  ].some((fragment) => message.includes(fragment));
}

export async function withTransientConnectRetry<T>(
  operation: () => Promise<T>,
  hooks: RetryHooks = {},
): Promise<T> {
  const maxRetries = hooks.maxRetries ?? DEFAULT_CONNECT_RETRIES;
  const delaysMs = hooks.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = hooks.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isTransientDatabaseConnectError(error)) throw error;
      const retryNumber = attempt + 1;
      hooks.onRetry?.(error, retryNumber);
      await sleep(delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0);
    }
  }
}

export class ResilientPgPool extends Pool {
  readonly applicationName: string;
  private connectRetries = 0;
  private recoveredConnects = 0;
  private exhaustedConnects = 0;
  private lastRetryAt: string | null = null;
  private lastRetryReason: string | null = null;

  constructor(config: PoolConfig) {
    super(config);
    this.applicationName = config.application_name ?? "amb-unknown";
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const acquire = async (): Promise<PoolClient> => {
      let retried = false;
      try {
        const client = await withTransientConnectRetry(
          () => super.connect(),
          {
            onRetry: (error) => {
              retried = true;
              this.connectRetries += 1;
              this.lastRetryAt = new Date().toISOString();
              this.lastRetryReason = safeErrorMessage(error);
            },
          },
        );
        if (retried) this.recoveredConnects += 1;
        return client;
      } catch (error) {
        if (retried) this.exhaustedConnects += 1;
        throw error;
      }
    };

    if (!callback) return acquire();
    void acquire().then(
      (client) => callback(undefined, client, client.release.bind(client)),
      (error: unknown) => callback(asError(error), undefined, () => undefined),
    );
  }

  diagnostics(): DatabasePoolDiagnostics {
    return {
      applicationName: this.applicationName,
      max: this.options.max,
      total: this.totalCount,
      idle: this.idleCount,
      waiting: this.waitingCount,
      connectRetries: this.connectRetries,
      recoveredConnects: this.recoveredConnects,
      exhaustedConnects: this.exhaustedConnects,
      lastRetryAt: this.lastRetryAt,
      lastRetryReason: this.lastRetryReason,
    };
  }
}

function databaseApplicationName(environment: NodeJS.ProcessEnv, argv: string[]): string {
  if (environment.AMB_DATABASE_APPLICATION_NAME) return environment.AMB_DATABASE_APPLICATION_NAME.slice(0, 63);
  const role = argv.find((argument) => argument.startsWith("--role="))?.slice("--role=".length);
  if (role) return `amb-worker-${role}`.slice(0, 63);
  const command = argv.join("/").replaceAll("\\", "/").toLowerCase();
  if (command.includes("apps/api/")) return "amb-api";
  if (command.includes("prisma")) return "amb-prisma";
  return "amb-tool";
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function errorChain(error: unknown): Array<{ code: string; message: string }> {
  const chain: Array<{ code: string; message: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && chain.length < 5) {
    seen.add(current);
    if (typeof current === "object") {
      const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
      chain.push({
        code: typeof candidate.code === "string" ? candidate.code : "",
        message: typeof candidate.message === "string" ? candidate.message : String(current),
      });
      current = candidate.cause;
    } else {
      chain.push({ code: "", message: String(current) });
      break;
    }
  }
  return chain;
}

function safeErrorMessage(error: unknown): string {
  return errorChain(error).map((entry) => entry.message).filter(Boolean).join(": ").slice(0, 500);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
