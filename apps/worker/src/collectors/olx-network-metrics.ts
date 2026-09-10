import type { SourceNetworkTelemetry } from "./source-http-network-telemetry.js";

type NetworkSample = Required<Pick<SourceNetworkTelemetry, "connectionReused">> & SourceNetworkTelemetry;

export class OlxNetworkMetrics {
  private readonly samples: NetworkSample[] = [];

  record(telemetry: SourceNetworkTelemetry | undefined): void {
    if (!telemetry || telemetry.connectionReused == null) return;
    this.samples.push({ ...telemetry, connectionReused: telemetry.connectionReused });
  }

  coverageMetrics(): Record<string, string | number | boolean | null> {
    const reused = this.samples.filter((sample) => sample.connectionReused).length;
    return {
      olxNetworkSamples: this.samples.length,
      olxNetworkReusedConnections: reused,
      olxNetworkReusePct: this.samples.length > 0
        ? rounded((reused / this.samples.length) * 100)
        : null,
      // CollectorRun coverage metrics are durable for every pass, including
      // passes with no new advert. Only bounded numeric timings are stored;
      // URLs, headers and request identifiers are deliberately excluded.
      olxNetworkSamplesJson: JSON.stringify(this.samples.slice(-50)),
    };
  }
}

export type NetworkPercentiles = {
  samples: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

export function summarizeOlxNetworkSamples(samples: readonly SourceNetworkTelemetry[]) {
  const reuseSamples = samples.filter((sample) => sample.connectionReused != null);
  const reused = reuseSamples.filter((sample) => sample.connectionReused).length;
  return {
    samples: samples.length,
    connectionReuse: {
      samples: reuseSamples.length,
      reused,
      percent: reuseSamples.length > 0 ? rounded((reused / reuseSamples.length) * 100) : null,
    },
    dispatcherWaitMs: percentiles(samples, "dispatcherWaitMs"),
    connectionSetupMs: percentiles(
      samples.filter((sample) => sample.connectionReused === false),
      "connectionSetupMs",
    ),
    wireTtfbMs: percentiles(samples, "wireTtfbMs"),
    downloadMs: percentiles(samples, "downloadMs"),
    responseBytes: percentiles(samples, "responseBytes"),
  };
}

export function parseOlxNetworkSamples(value: unknown): SourceNetworkTelemetry[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const input = candidate as Record<string, unknown>;
      const sample: SourceNetworkTelemetry = {};
      for (const field of [
        "dispatcherWaitMs",
        "connectionSetupMs",
        "wireTtfbMs",
        "downloadMs",
        "responseBytes",
      ] as const) {
        const number = input[field];
        if (typeof number === "number" && Number.isFinite(number) && number >= 0) sample[field] = number;
      }
      if (typeof input.connectionReused === "boolean") sample.connectionReused = input.connectionReused;
      return Object.keys(sample).length > 0 ? [sample] : [];
    });
  } catch {
    return [];
  }
}

function percentiles(
  samples: readonly SourceNetworkTelemetry[],
  field: keyof SourceNetworkTelemetry,
): NetworkPercentiles {
  const values = samples
    .map((sample) => sample[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return rounded(values[index]!);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
