import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("watchdog Telegram global rate gate", () => {
  it("reserves the same Redis TIME namespace before sending", async () => {
    const source = await readFile(new URL("../scripts/watchdog.ps1", import.meta.url), "utf8");
    const waitDefinition = source.indexOf("function Wait-TelegramGlobalSlot");
    const waitCall = source.indexOf("Wait-TelegramGlobalSlot -Token $token -ChatId $chatId");
    const sendCall = source.indexOf("Invoke-RestMethod -Method Post -Uri \"https://api.telegram.org/bot$token/sendMessage\"");

    expect(waitDefinition).toBeGreaterThanOrEqual(0);
    expect(source).toContain('"amb:telegram:rate:v1:$botId`:$safeChatId"');
    expect(source).toContain('redis.call("TIME")');
    expect(waitCall).toBeGreaterThan(waitDefinition);
    expect(sendCall).toBeGreaterThan(waitCall);
  });
});
