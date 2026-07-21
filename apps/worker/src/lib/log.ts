import { prisma } from "@amb/db";

type Level = "INFO" | "WARN" | "ERROR";

async function writeLog(level: Level, scope: string, message: string, details?: string): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: { level, scope, message, details: details ?? null },
    });
  } catch (err) {
    console.error("[worker] failed to write log:", err);
  }
}

export const log = {
  info: (scope: string, message: string, details?: string) => writeLog("INFO", scope, message, details),
  warn: (scope: string, message: string, details?: string) => writeLog("WARN", scope, message, details),
  error: (scope: string, message: string, details?: string) => writeLog("ERROR", scope, message, details),
};
