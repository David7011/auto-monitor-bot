import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@amb/db";
import { hashDashboardPassword, verifyDashboardPassword } from "../modules/dashboard-password.js";
import {
  clearLoginFailures,
  loginRateLimitStatus,
  recordLoginAttempt,
  recordLoginFailure,
} from "../modules/dashboard-login-rate-limit.js";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(300),
  clientId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});
const sessionSchema = z.object({
  username: z.string().trim().min(1).max(80),
  authVersion: z.number().int().positive(),
});
const dummyHash = hashDashboardPassword("invalid-dashboard-user-password");

export async function dashboardAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/dashboard-auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid login payload", code: "INVALID_LOGIN_PAYLOAD" });

    const clientId = parsed.data.clientId ?? req.ip;
    let limit: Awaited<ReturnType<typeof loginRateLimitStatus>>;
    try {
      limit = await loginRateLimitStatus(parsed.data.username, clientId);
      if (!limit.blocked) await recordLoginAttempt(parsed.data.username, clientId);
    } catch {
      return reply.code(503).send({ error: "Authentication rate limiter is unavailable", code: "AUTH_RATE_LIMITER_UNAVAILABLE" });
    }
    if (limit.blocked) {
      return reply.header("retry-after", String(limit.retryAfterSeconds)).code(429).send({
        error: "Too many login attempts",
        code: "LOGIN_RATE_LIMITED",
      });
    }

    const user = await prisma.dashboardUser.findUnique({ where: { username: parsed.data.username } });
    const passwordHash = user?.passwordHash ?? await dummyHash;
    const passwordMatches = await verifyDashboardPassword(parsed.data.password, passwordHash);
    const valid = Boolean(user?.enabled && passwordMatches);
    if (!user || !valid) {
      try {
        await recordLoginFailure(parsed.data.username, clientId);
      } catch {
        return reply.code(503).send({ error: "Authentication rate limiter is unavailable", code: "AUTH_RATE_LIMITER_UNAVAILABLE" });
      }
      return reply.code(401).send({ error: "Invalid username or password", code: "INVALID_CREDENTIALS" });
    }

    try {
      await clearLoginFailures(parsed.data.username, clientId);
    } catch {
      return reply.code(503).send({ error: "Authentication rate limiter is unavailable", code: "AUTH_RATE_LIMITER_UNAVAILABLE" });
    }

    await prisma.dashboardUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        authVersion: user.authVersion,
      },
    };
  });

  app.post("/dashboard-auth/session", async (req, reply) => {
    const parsed = sessionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false });
    const user = await prisma.dashboardUser.findUnique({
      where: { username: parsed.data.username },
      select: { enabled: true, authVersion: true },
    });
    return { ok: Boolean(user?.enabled && user.authVersion === parsed.data.authVersion) };
  });
}
