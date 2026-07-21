import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { prisma } from "../packages/db/dist/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(projectRoot, ".env"));

const scrypt = promisify(scryptCallback);
const username = process.env.DASHBOARD_SEED_USERNAME || process.env.DASHBOARD_USERNAME || process.argv[2] || "david";
const password = process.env.DASHBOARD_SEED_PASSWORD || process.env.DASHBOARD_PASSWORD || process.argv[3];

if (!password) {
  console.error("DASHBOARD_SEED_PASSWORD is required");
  process.exit(1);
}

try {
  const passwordHash = await hashPassword(password);
  const user = await prisma.dashboardUser.upsert({
    where: { username },
    create: {
      username,
      passwordHash,
      enabled: true,
    },
    update: {
      passwordHash,
      enabled: true,
      authVersion: { increment: 1 },
    },
    select: {
      id: true,
      username: true,
      enabled: true,
      authVersion: true,
      updatedAt: true,
    },
  });
  console.log(JSON.stringify({ ok: true, user }, null, 2));
} finally {
  await prisma.$disconnect();
}

async function hashPassword(value) {
  const salt = randomBytes(24).toString("base64url");
  const derived = await scrypt(value, salt, 64);
  return `scrypt:v1:${salt}:${derived.toString("base64url")}`;
}

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    const name = key.trim();
    if (!name || process.env[name] != null) continue;
    process.env[name] = rest.join("=").trim().replace(/^["']|["']$/gu, "");
  }
}
