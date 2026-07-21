import { env } from "../env.js";
import { log } from "../lib/log.js";

const NBU_USD_URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json";

type NbuRate = {
  cc?: string;
  rate?: number;
  exchangedate?: string;
};

let currentRate = env.PRICE_UAH_PER_USD;
let currentDate: Date | undefined;

export function currentUsdExchangeRate(): { rate: number; date?: Date; provider: "NBU" | "FALLBACK" } {
  return {
    rate: currentRate,
    date: currentDate,
    provider: currentDate ? "NBU" : "FALLBACK",
  };
}

export async function refreshUsdExchangeRate(): Promise<void> {
  try {
    const response = await fetch(NBU_USD_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`NBU HTTP ${response.status}`);
    const rows = await response.json() as NbuRate[];
    const usd = rows.find((row) => row.cc?.toUpperCase() === "USD");
    if (!usd?.rate || !Number.isFinite(usd.rate) || usd.rate <= 0) throw new Error("NBU USD rate is missing");

    currentRate = usd.rate;
    currentDate = parseNbuDate(usd.exchangedate) ?? new Date();
  } catch (error) {
    await log.warn(
      "exchange-rate",
      `NBU rate unavailable; using configured fallback ${currentRate}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseNbuDate(value: string | undefined): Date | undefined {
  const match = value?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? undefined : date;
}
