import { prisma } from "@amb/db";

export async function logError(scope: string, message: string, details?: string): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: { level: "ERROR", scope, message, details: details ?? null },
    });
  } catch (err) {
    console.error("[api] failed to write error log:", err);
  }
}

export async function logInfo(scope: string, message: string, details?: string): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: { level: "INFO", scope, message, details: details ?? null },
    });
  } catch (err) {
    console.error("[api] failed to write info log:", err);
  }
}
