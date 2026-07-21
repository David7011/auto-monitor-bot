import { createConnection } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

function loadEnv() {
  const env = { ...process.env };
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    const value = rest.join("=").trim().replace(/^["']|["']$/gu, "");
    if (key && env[key] == null) env[key] = value;
  }
  return env;
}

function run(command, args) {
  const isWindowsPnpm = process.platform === "win32" && command === "pnpm";
  const executable = isWindowsPnpm ? process.env.ComSpec || "cmd.exe" : command;
  const commandArgs = isWindowsPnpm ? ["/d", "/s", "/c", ["pnpm", ...args].join(" ")] : args;
  const result = spawnSync(executable, commandArgs, { encoding: "utf8", shell: false });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function tcpCheck(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok, message) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, message });
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true, `${host}:${port} reachable`));
    socket.on("timeout", () => done(false, `${host}:${port} timeout`));
    socket.on("error", (err) => done(false, `${host}:${port} ${err.message}`));
  });
}

function redisVersionCheck(host, port, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let buffer = "";
    let settled = false;
    const done = (ok, message) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, message });
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write("*2\r\n$4\r\nINFO\r\n$6\r\nserver\r\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const version = buffer.match(/^redis_version:([^\r\n]+)$/m)?.[1]?.trim();
      if (!version) return;
      const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
      const compatible = major > 6 || (major === 6 && minor >= 2);
      done(compatible, compatible ? `Redis ${version}, BullMQ compatible` : `Redis ${version}; version 6.2+ is required`);
    });
    socket.on("timeout", () => done(false, `${host}:${port} INFO timeout`));
    socket.on("error", (err) => done(false, `${host}:${port} ${err.message}`));
  });
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function print(name, ok, details = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${details ? ` - ${details}` : ""}`);
}

const env = loadEnv();
const node = run("node", ["-v"]);
const pnpm = run("pnpm", ["-v"]);
const prismaClientPath = path.join(root, "node_modules", ".pnpm");

print("Node.js", node.ok, node.output);
print("pnpm", pnpm.ok, pnpm.output);
print(".env", existsSync(envPath), envPath);
print("DATABASE_URL set", Boolean(env.DATABASE_URL));
print("REDIS_URL set", Boolean(env.REDIS_URL));
print("TELEGRAM_BOT_TOKEN set", Boolean(env.TELEGRAM_BOT_TOKEN));
print("TELEGRAM_CHAT_ID set", Boolean(env.TELEGRAM_CHAT_ID));
print("LOCAL_API_TOKEN set", Boolean(env.LOCAL_API_TOKEN));
print("INTERNAL_API_URL set", Boolean(env.INTERNAL_API_URL));
print("Prisma client installed", existsSync(prismaClientPath), "node_modules/.pnpm");

const dbUrl = parseUrl(env.DATABASE_URL ?? "");
const redisUrl = parseUrl(env.REDIS_URL ?? "");
let failed = false;

if (!node.ok || !pnpm.ok || !existsSync(envPath) || !env.DATABASE_URL || !env.REDIS_URL) failed = true;

if (dbUrl) {
  const dbCheck = await tcpCheck(dbUrl.hostname, Number(dbUrl.port || 5432));
  print("PostgreSQL TCP", dbCheck.ok, dbCheck.message);
  if (!dbCheck.ok) failed = true;
} else {
  print("PostgreSQL TCP", false, "DATABASE_URL is invalid");
  failed = true;
}

if (redisUrl) {
  const redisCheck = await redisVersionCheck(redisUrl.hostname, Number(redisUrl.port || 6379));
  print("Redis/BullMQ", redisCheck.ok, redisCheck.message);
  if (!redisCheck.ok) failed = true;
} else {
  print("Redis/BullMQ", false, "REDIS_URL is invalid");
  failed = true;
}

const apiHost = env.API_HOST || "127.0.0.1";
const apiPort = Number(env.API_PORT || 4000);
print("API bind config", apiHost === "127.0.0.1", `API_HOST=${apiHost}, API_PORT=${apiPort}`);

process.exit(failed ? 1 : 0);
