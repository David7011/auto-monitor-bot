import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@amb/db";
import {
  type SettingsResponse,
  type SystemCheckResponse,
} from "@amb/shared";
import { env } from "../env.js";
import { getQueueCounts, getRedisDiagnostics, queueFailureSummary } from "../lib/queues.js";
import { boundedIntegerQuery, cursorQuery } from "../lib/query-validation.js";
import { sourceProtectionHealth } from "../lib/source-protection-health.js";
import { sourcePortfolioHealth } from "../lib/source-portfolio-health.js";
import {
  getListingRetentionHealth,
  type CheckStatus,
} from "./system-retention-health.js";

const settingsSchema = z.object({
  intervalSeconds: z.number().int().min(10).max(3600).optional(),
  jitterSeconds: z.number().int().min(0).max(120).optional(),
});

export async function systemAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string; level?: string; cursor?: string } }>("/logs", async (req, reply) => {
    const limit = boundedIntegerQuery(req.query.limit, { fallback: 100, max: 500 });
    if (limit == null) return reply.code(400).send({ error: "limit must be an integer between 1 and 500" });
    const cursor = cursorQuery(req.query.cursor);
    if (cursor === null) return reply.code(400).send({ error: "cursor is invalid" });
    const level = req.query.level;
    const rows = await prisma.errorLog.findMany({
      where: level && ["INFO", "WARN", "ERROR"].includes(level)
        ? { level: level as "INFO" | "WARN" | "ERROR" }
        : undefined,
      orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;
    return { logs, nextCursor: hasMore ? logs.at(-1)?.id ?? null : null };
  });

  app.get("/settings", async () => {
    const state = await prisma.monitoringState.findUnique({ where: { id: "singleton" } });
    return {
      intervalSeconds: state?.intervalSeconds ?? 120,
      jitterSeconds: state?.jitterSeconds ?? 20,
      telegramChatId: env.TELEGRAM_CHAT_ID || null,
      telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    } satisfies SettingsResponse;
  });

  app.patch("/settings", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const state = await prisma.monitoringState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...parsed.data },
      update: parsed.data,
    });
    return { ok: true, intervalSeconds: state.intervalSeconds, jitterSeconds: state.jitterSeconds };
  });

  app.get("/system/check", async () => {
    const checks: Array<{ name: string; status: CheckStatus; message: string }> = [];
    try {
      const retention = await getListingRetentionHealth(new Date());
      checks.push({
        name: "Хранение объявлений",
        status: retention.status === "IDLE" || retention.status === "NOT_CONFIGURED"
          ? "WARN"
          : retention.status,
        message: retention.message,
      });
    } catch (err) {
      checks.push({
        name: "Хранение объявлений",
        status: "FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.push({ name: "База данных", status: "OK", message: "PostgreSQL доступен" });
    } catch (err) {
      checks.push({
        name: "База данных",
        status: "FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const diagnostics = await getRedisDiagnostics();
      const queues = await getQueueCounts();
      const failures = queueFailureSummary(queues);
      checks.push({
        name: "Очереди",
        status: failures.recent > 0 ? "WARN" : "OK",
        message: failures.recent > 0
          ? `Redis ${diagnostics.version}: недавних заданий с ошибкой: ${failures.recent}; исторических: ${failures.historical}`
          : failures.historical > 0
            ? `Redis ${diagnostics.version} и BullMQ доступны; исторических завершённых сбоев: ${failures.historical}`
            : `Redis ${diagnostics.version} и BullMQ доступны`,
      });
    } catch (err) {
      checks.push({
        name: "Очереди",
        status: "FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
    checks.push({
      name: "Telegram",
      status: telegramConfigured ? "OK" : "WARN",
      message: telegramConfigured ? "Токен бота и получатель настроены" : "Telegram не настроен",
    });

    checks.push({
      name: "AUTO.RIA",
      status: env.AUTO_RIA_API_KEY ? "OK" : "WARN",
      message: env.AUTO_RIA_API_KEY
        ? `API-ключ настроен, часовой лимит: ${env.AUTO_RIA_HOURLY_REQUEST_LIMIT}, платные методы: ${
          env.AUTO_RIA_PAID_ENRICHMENT_ENABLED ? "включены" : "выключены"
        }`
        : "API-ключ AUTO.RIA не настроен",
    });

    const [realSourceRows, activeRealFilters, monitoringState] = await Promise.all([
      prisma.source.findMany({
        where: {
          enabled: true,
          source: { in: ["OLX", "RST", "CARS_UA", "AUTOMOTO", "AUTO_RIA"] },
        },
        select: {
          source: true,
          enabled: true,
          status: true,
          intervalSeconds: true,
          lastSuccessfulAt: true,
        },
      }),
      prisma.filter.count({
        where: {
          enabled: true,
          sources: { hasSome: ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO"] },
        },
      }),
      prisma.monitoringState.findUnique({
        where: { id: "singleton" },
        select: { status: true },
      }),
    ]);

    checks.push({
      name: "Источники",
      status: realSourceRows.some((source) => ["ACTIVE", "LIMITED"].includes(source.status)) ? "OK" : "WARN",
      message: `Включённых реальных источников: ${realSourceRows.length}`,
    });
    const portfolio = sourcePortfolioHealth({
      sources: realSourceRows,
      monitoringRunning: monitoringState?.status === "RUNNING",
    });
    checks.push({
      name: "Live-покрытие",
      status: portfolio.status,
      message: portfolio.message,
    });
    checks.push({
      name: "Фильтры",
      status: activeRealFilters > 0 ? "OK" : "WARN",
      message: `Активных реальных фильтров: ${activeRealFilters}`,
    });

    const protectionCheckedAt = new Date();
    const [olxProtection, secondaryCaptcha, secondaryRateLimited, secondaryPaused] = await Promise.all([
      prisma.source.findUnique({
        where: { source: "OLX" },
        select: { enabled: true, status: true, pausedUntil: true },
      }),
      prisma.source.count({ where: { enabled: true, source: { not: "OLX" }, status: "CAPTCHA_DETECTED" } }),
      prisma.source.count({ where: { enabled: true, source: { not: "OLX" }, status: "RATE_LIMITED" } }),
      prisma.source.count({
        where: { enabled: true, source: { not: "OLX" }, pausedUntil: { gt: protectionCheckedAt } },
      }),
    ]);
    const protection = sourceProtectionHealth({
      olx: olxProtection
        ? {
            enabled: olxProtection.enabled,
            status: olxProtection.status,
            paused: Boolean(olxProtection.pausedUntil && olxProtection.pausedUntil > protectionCheckedAt),
            pausedUntil: olxProtection.pausedUntil,
          }
        : null,
      secondaryCaptcha,
      secondaryRateLimited,
      secondaryPaused,
    });
    checks.push({
      name: "Защита источников",
      status: protection.status,
      message: protection.message,
    });

    const degradedParsers = await prisma.source.count({
      where: {
        enabled: true,
        OR: [{ healthScore: { lt: 50 } }, { consecutiveEmptyResults: { gte: 3 } }],
      },
    });
    checks.push({
      name: "Состояние парсеров",
      status: degradedParsers > 0 ? "WARN" : "OK",
      message: degradedParsers > 0
        ? `Парсеров, требующих внимания: ${degradedParsers}`
        : "Парсеры источников возвращают корректные данные",
    });

    const status: CheckStatus = checks.some((check) => check.status === "FAIL")
      ? "FAIL"
      : checks.some((check) => check.status === "WARN")
        ? "WARN"
        : "OK";

    return { status, checks, checkedAt: new Date().toISOString() } satisfies SystemCheckResponse;
  });
}
