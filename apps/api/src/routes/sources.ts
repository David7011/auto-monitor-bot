import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@amb/db";
import { safeSourceEnableTransition } from "../lib/manual-source-check.js";
import {
  checkActiveSourcesNow,
  checkSourceNow,
  disableBulkRealSources,
  enableBulkRealSources,
  getSourcesStatus,
} from "../modules/sources/control.js";

const patchSourceSchema = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(2).max(3600).optional(),
  jitterSeconds: z.number().int().min(0).max(300).optional(),
  status: z.enum(["ACTIVE", "PAUSED", "DISABLED"]).optional(),
});

export async function sourcesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/sources", async () => {
    return getSourcesStatus();
  });

  app.get("/sources/status", async () => {
    return getSourcesStatus();
  });

  app.post("/sources/check-active", async (_req, reply) => {
    const result = await checkActiveSourcesNow();
    if (!result.ok) return reply.code(result.statusCode).send(result.body);
    return result;
  });

  app.post("/sources/real/enable", async () => {
    return enableBulkRealSources();
  });

  app.post("/sources/real/disable", async () => {
    return disableBulkRealSources();
  });

  app.post<{ Params: { id: string } }>("/sources/:id/check-now", async (req, reply) => {
    const source = await prisma.source.findUnique({ where: { id: req.params.id } });
    if (!source) return reply.code(404).send({ error: "Source not found" });

    const result = await checkSourceNow(source);
    if (!result.ok) return reply.code(result.statusCode).send(result.body);
    return result;
  });

  app.patch<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    const parsed = patchSourceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const source = await prisma.source.findUnique({ where: { id: req.params.id } });
    if (!source) return reply.code(404).send({ error: "Source not found" });

    const data: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.enabled === true && source.status === "DISABLED") {
      const transition = safeSourceEnableTransition(source);
      data.status = transition.status;
      data.pausedUntil = transition.pausedUntil;
      data.nextCheckAt = transition.nextCheckAt;
      if (transition.resetErrors) {
        data.consecutiveErrors = 0;
        data.lastError = null;
      }
    }
    if (parsed.data.status === "ACTIVE" && source.pausedUntil && source.pausedUntil > new Date()) {
      data.status = "PAUSED";
      data.nextCheckAt = source.pausedUntil;
    }
    if (parsed.data.enabled === false) {
      data.status = "DISABLED";
    }

    const updated = await prisma.source.update({ where: { id: source.id }, data });
    return { ok: true, source: updated };
  });
}
