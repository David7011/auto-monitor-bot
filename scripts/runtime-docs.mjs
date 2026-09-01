import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = path.join(root, ".env.example");
const livePath = path.join(root, ".env");
const readmePath = path.join(root, "README.md");
const startMarker = "<!-- runtime-config:start -->";
const endMarker = "<!-- runtime-config:end -->";

const settings = [
  ["OLX realtime", "LIVE_OLX_INTERVAL_SECONDS", "Интервал быстрого OLX-прохода", [["apps/api/src/env.ts", "number"]]],
  ["OLX realtime", "LIVE_OLX_JITTER_SECONDS", "Случайный разброс быстрого прохода", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_ENABLED", "Автоматический переход 20±4 → 15±3", [["apps/api/src/env.ts", "boolean"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_QUALIFICATION_RUNS", "Чистых baseline-проходов до canary", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_PROMOTION_RUNS", "Чистых canary-проходов до promotion", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_INTERVAL_SECONDS", "Интервал экспериментального realtime", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_JITTER_SECONDS", "Jitter экспериментального realtime", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_QUALIFICATION_MAX_P95_MS", "Максимальный baseline p95 для допуска", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_MAX_P95_MS", "Жёсткий latency rollback-порог", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_P95_MIN_SAMPLES", "Минимальная canary-выборка для p95", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_P95_GROWTH_PERCENT", "Допустимый рост p95 к baseline, процентов", [["apps/api/src/env.ts", "number"]]],
  ["OLX canary", "OLX_CADENCE_CANARY_QUEUE_DEPTH_LIMIT", "Максимальная hot-queue глубина", [["apps/api/src/env.ts", "number"]]],
  ["OLX realtime", "OLX_REALTIME_RECOVERY_RAMP_SECONDS", "Плавный возврат скорости после защиты", [["apps/api/src/env.ts", "number"]]],
  ["OLX origin", "OLX_REALTIME_QUIET_CANARY_ENABLED", "Безопасный canary post-finish паузы 350 → 150 мс", [["apps/worker/src/env.ts", "boolean"]]],
  ["OLX origin", "OLX_REALTIME_QUIET_CANARY_CANDIDATE_MS", "Canary-пауза между последовательными realtime запросами", [["apps/worker/src/env.ts", "number"]]],
  ["OLX origin", "OLX_REALTIME_QUIET_CANARY_QUALIFICATION_REQUESTS", "Чистых origin-запросов до canary", [["apps/worker/src/env.ts", "number"]]],
  ["OLX origin", "OLX_REALTIME_QUIET_CANARY_EVALUATION_REQUESTS", "Canary-запросов до promotion", [["apps/worker/src/env.ts", "number"]]],
  ["OLX origin", "OLX_REALTIME_QUIET_CANARY_P95_GROWTH_PERCENT", "Максимальный p95 относительно baseline, процентов", [["apps/worker/src/env.ts", "number"]]],
  ["OLX origin", "OLX_REALTIME_QUIET_CANARY_QUEUE_DEPTH_LIMIT", "Очередь realtime для мгновенного rollback", [["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_API_PAGE_SIZE", "Размер страницы публичного API", [["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_KNOWN_IDS_RESET_THRESHOLD", "Порог полного сброса лёгкого кэша OLX ID", [["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_REALTIME_MAX_PAGES", "Максимум realtime-страниц", [["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_BACKFILL_MAX_PAGES", "Максимум страниц глубокой сверки", [["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_COVERAGE_INTERVAL_SECONDS", "Интервал durable regional/HTML/private сверки", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_COVERAGE_INITIAL_DELAY_SECONDS", "Задержка coverage после старта realtime", [["apps/api/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_COVERAGE_MAX_DURATION_MS", "Жёсткий бюджет одного coverage run", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "WORKER_CONCURRENCY_COLLECTOR_COVERAGE", "Параллельность отдельной coverage очереди", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_HTML_COVERAGE_INTERVAL_SECONDS", "Интервал HTML-сверки", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["OLX полнота", "OLX_PRIVATE_COVERAGE_INTERVAL_SECONDS", "Интервал private-сверки", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["Backfill", "BACKFILL_INTERVAL_SECONDS", "Интервал фоновой сверки", [["apps/api/src/env.ts", "number"]]],
  ["Backfill", "OLX_BACKFILL_MIN_INTERVAL_SECONDS", "Минимальный интервал фоновой OLX-сверки", [["apps/api/src/env.ts", "number"]]],
  ["Backfill", "BACKFILL_MAX_CANDIDATES", "Лимит кандидатов одной сверки", [["apps/worker/src/env.ts", "number"]]],
  ["Защита", "RATE_LIMIT_PAUSE_BASE_SECONDS", "Начальная пауза rate limit", [["apps/worker/src/env.ts", "number"]]],
  ["Защита", "RATE_LIMIT_PAUSE_MAX_SECONDS", "Максимальная пауза rate limit", [["apps/worker/src/env.ts", "number"]]],
  ["Защита", "CAPTCHA_PAUSE_SECONDS", "Начальная пауза CAPTCHA", [["apps/worker/src/env.ts", "number"]]],
  ["Защита", "OLX_PROTECTION_COOLING_SECONDS", "Период щадящего режима после защиты OLX", [["apps/worker/src/env.ts", "number"]]],
  ["Telegram", "FAST_INLINE_TELEGRAM_SEND_ENABLED", "Первое сообщение на fast path", [["apps/worker/src/env.ts", "boolean"]]],
  ["Telegram", "FAST_INLINE_LISTING_PROCESSING_ENABLED", "Inline-обработка найденных карточек", [["apps/worker/src/env.ts", "boolean"]]],
  ["Telegram", "FAST_INLINE_LISTING_CONCURRENCY", "Параллельность fast path", [["apps/worker/src/env.ts", "number"]]],
  ["Telegram", "FAST_INLINE_TELEGRAM_DEADLINE_MS", "Жёсткий deadline inline-отправки", [["apps/worker/src/env.ts", "number"]]],
  ["Telegram", "TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS", "Глобальный интервал начала отправки", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["Telegram", "TELEGRAM_FLASH_BUNDLE_ENABLED", "Ссылки burst сначала одним flash-сообщением", [["apps/api/src/env.ts", "boolean"], ["apps/worker/src/env.ts", "boolean"]]],
  ["Telegram", "TELEGRAM_FLASH_BUNDLE_MIN_ITEMS", "Минимальный размер flash bundle", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["Telegram", "TELEGRAM_FLASH_BUNDLE_MAX_ITEMS", "Максимум ссылок в одном flash bundle", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["Telegram", "WORKER_CONCURRENCY_TELEGRAM_FLASH", "Параллельность durable flash-очереди", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["Хранение", "LISTING_RETENTION_HOURS", "Срок обычной карточки", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["Хранение", "LISTING_FAVORITE_RETENTION_DAYS", "Срок избранной карточки", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
  ["Хранение", "LISTING_CLEANUP_INTERVAL_MS", "Интервал очистки карточек", [["apps/api/src/env.ts", "number"], ["apps/worker/src/env.ts", "number"]]],
];

const runtimeEnvSources = ["apps/api/src/env.ts", "apps/worker/src/env.ts"];

function parseEnv(text) {
  const result = new Map();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/u, "$2");
    result.set(key, value);
  }
  return result;
}

function evaluateNumeric(expression, key, file) {
  if (!/^[\d_+*/().\s-]+$/u.test(expression)) {
    throw new Error(`Unsafe numeric fallback for ${key} in ${file}: ${expression}`);
  }
  const value = Function(`"use strict"; return (${expression.replaceAll("_", "")});`)();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid numeric fallback for ${key} in ${file}`);
  }
  return String(value);
}

function sourceFallback(source, key, kind, file) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (kind === "number") {
    const match = source.match(new RegExp(`numberEnv\\("${escaped}",\\s*([^\\n\\r)]+(?:\\([^\\n\\r)]*\\)[^\\n\\r)]*)?)\\)`));
    if (!match) throw new Error(`Fallback ${key} not found in ${file}`);
    return evaluateNumeric(match[1].trim(), key, file);
  }
  const match = source.match(new RegExp(`booleanEnv\\("${escaped}",\\s*(true|false)\\)`));
  if (!match) throw new Error(`Fallback ${key} not found in ${file}`);
  return match[1];
}

function enumFallback(source, key, file) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(new RegExp(`enumEnv\\("${escaped}",[\\s\\S]*?,\\s*"([^"]+)"\\)`));
  if (!match) throw new Error(`Enum fallback ${key} not found in ${file}`);
  return match[1];
}

function discoveredFallbacks(source, file) {
  const discovered = [];
  for (const match of source.matchAll(/\b(numberEnv|booleanEnv|enumEnv)\("([A-Z][A-Z0-9_]*)"/gu)) {
    const [, reader, key] = match;
    const kind = reader === "numberEnv" ? "number" : reader === "booleanEnv" ? "boolean" : "enum";
    const value = kind === "enum" ? enumFallback(source, key, file) : sourceFallback(source, key, kind, file);
    discovered.push({ key, value, file });
  }
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*\?\?\s*"([^"]*)"/gu)) {
    discovered.push({ key: match[1], value: match[2], file });
  }
  return discovered;
}

async function validateCompleteRuntimeEnv(exampleValues) {
  const seen = new Map();
  for (const relativeFile of runtimeEnvSources) {
    const source = await readFile(path.join(root, relativeFile), "utf8");
    for (const entry of discoveredFallbacks(source, relativeFile)) {
      const documented = exampleValues.get(entry.key);
      if (documented == null) throw new Error(`${entry.key} is used in ${relativeFile} but missing in .env.example`);
      // Empty code fallbacks mark required/optional operator-provided values.
      // Their examples may intentionally contain a local connection template.
      if (entry.value !== "" && documented !== entry.value) {
        throw new Error(`${entry.key} drift: .env.example=${documented}, ${relativeFile} fallback=${entry.value}`);
      }
      const previous = seen.get(entry.key);
      if (previous && previous.value !== entry.value) {
        throw new Error(`${entry.key} has conflicting fallbacks: ${previous.file}=${previous.value}, ${relativeFile}=${entry.value}`);
      }
      seen.set(entry.key, entry);
    }
  }
  return seen;
}

function render(values, heading) {
  const lines = [
    heading,
    "",
    "| Группа | Параметр | Значение | Назначение |",
    "|---|---|---:|---|",
  ];
  for (const [group, key, description] of settings) {
    lines.push(`| ${group} | \`${key}\` | \`${values.get(key) ?? "—"}\` | ${description} |`);
  }
  return lines.join("\n");
}

function replaceGeneratedBlock(readme, generated) {
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error("README runtime-config markers are missing or invalid");
  return `${readme.slice(0, start)}${startMarker}\n${generated}\n${endMarker}${readme.slice(end + endMarker.length)}`;
}

const exampleText = await readFile(examplePath, "utf8");
const exampleValues = parseEnv(exampleText);
const completeRuntimeEnv = await validateCompleteRuntimeEnv(exampleValues);
const sourceCache = new Map();
for (const [, key, , sources] of settings) {
  const documented = exampleValues.get(key);
  if (documented == null) throw new Error(`${key} is missing in .env.example`);
  for (const [relativeFile, kind] of sources) {
    let source = sourceCache.get(relativeFile);
    if (!source) {
      source = await readFile(path.join(root, relativeFile), "utf8");
      sourceCache.set(relativeFile, source);
    }
    const fallback = sourceFallback(source, key, kind, relativeFile);
    if (fallback !== documented) {
      throw new Error(`${key} drift: .env.example=${documented}, ${relativeFile} fallback=${fallback}`);
    }
  }
}

if (process.argv.includes("--live")) {
  let liveValues = new Map();
  try {
    liveValues = parseEnv(await readFile(livePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const effective = new Map(settings.map(([, key]) => [key, liveValues.get(key) ?? exampleValues.get(key)]));
  console.log(render(effective, "Локальная эффективная конфигурация (только безопасный whitelist):"));
  process.exit(0);
}

const generated = render(
  exampleValues,
  "Этот блок генерируется из `.env.example`; `pnpm docs:check` также сверяет значения с fallback-настройками API и worker.",
);
const readme = await readFile(readmePath, "utf8");
const expected = replaceGeneratedBlock(readme, generated);

if (process.argv.includes("--write")) {
  await writeFile(readmePath, expected, "utf8");
  console.log("README runtime configuration synchronized.");
} else if (expected !== readme) {
  throw new Error("README runtime configuration is stale. Run: pnpm docs:sync");
} else {
  console.log(
    `Runtime documentation matches .env.example and ${completeRuntimeEnv.size} discovered API/worker fallbacks.`,
  );
}
