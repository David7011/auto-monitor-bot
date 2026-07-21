import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

function token() {
  return `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
}

function get(text, key) {
  const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

function set(text, key, value) {
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.trimEnd()}\r\n${line}\r\n`;
}

function setDefault(text, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) return text;
  return `${text.trimEnd()}\r\n${key}=${value}\r\n`;
}

function remove(text, key) {
  return text.replace(new RegExp(`^${key}=.*(?:\\r?\\n)?`, "m"), "");
}

let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const localToken = get(text, "LOCAL_API_TOKEN") || token();
const backupPassword = get(text, "BACKUP_ENCRYPTION_PASSWORD") || token();
const redisUrl = get(text, "REDIS_URL");

text = set(text, "API_HOST", "127.0.0.1");
text = set(text, "DASHBOARD_ORIGIN", "http://localhost:3001");
text = set(text, "INTERNAL_API_URL", "http://127.0.0.1:4000");
text = set(text, "LOCAL_API_TOKEN", localToken);
text = set(text, "BACKUP_ENCRYPTION_PASSWORD", backupPassword);
if (!redisUrl || ["redis://localhost:6379", "redis://127.0.0.1:6379"].includes(redisUrl)) {
  text = set(text, "REDIS_URL", "redis://127.0.0.1:6380");
}
text = set(text, "ALLOW_MANUAL_CHECK_WHEN_STOPPED", "true");
text = set(text, "MANUAL_CHECK_DEDUP_SECONDS", "30");
text = setDefault(text, "AUTO_RIA_API_KEY", '""');
text = setDefault(text, "AUTO_RIA_USER_ID", '""');
text = setDefault(text, "AUTO_RIA_TOTAL_REQUEST_LIMIT", "1000");
text = setDefault(text, "AUTO_RIA_HOURLY_REQUEST_LIMIT", "30");
text = setDefault(text, "AUTO_RIA_SOFT_RESERVE", "100");
text = setDefault(text, "AUTO_RIA_MIN_SEARCH_RESERVE", "50");
text = setDefault(text, "AUTO_RIA_MAX_INFO_PER_SCAN", "10");
text = setDefault(text, "AUTO_RIA_PAID_ENRICHMENT_ENABLED", "false");
text = setDefault(text, "AUTO_RIA_VIN_LOOKUP_ENABLED", "false");
text = setDefault(text, "AUTO_RIA_AVERAGE_PRICE_ENABLED", "false");
text = setDefault(text, "FAKE_VEHICLE_CHECK_ENABLED", "false");
text = remove(text, "NEXT_PUBLIC_LOCAL_API_TOKEN");
text = remove(text, "NEXT_PUBLIC_API_URL");
writeFileSync(envPath, text, { encoding: "utf8" });
console.log("Local API secrets are configured.");
