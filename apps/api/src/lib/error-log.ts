import { writeDeduplicatedLog } from "@amb/db";

export async function logError(scope: string, message: string, details?: string): Promise<void> {
  try {
    await writeDeduplicatedLog("ERROR", scope, message, details);
  } catch (err) {
    console.error("[api] failed to write error log:", err);
  }
}

export async function logInfo(scope: string, message: string, details?: string): Promise<void> {
  try {
    await writeDeduplicatedLog("INFO", scope, message, details);
  } catch (err) {
    console.error("[api] failed to write info log:", err);
  }
}

export async function logWarn(scope: string, message: string, details?: string): Promise<void> {
  try {
    await writeDeduplicatedLog("WARN", scope, message, details);
  } catch (err) {
    console.error("[api] failed to write warning log:", err);
  }
}
