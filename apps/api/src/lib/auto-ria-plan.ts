export type AutoRiaPlanIssue = {
  level: "ok" | "warning" | "danger";
  message: string;
};

type AutoRiaFilterIdentity = {
  brand: string | null;
  model: string | null;
  autoRiaMarkId: number | null;
  autoRiaModelId: number | null;
};

/**
 * AUTO.RIA mark/model identifiers are meaningful only for a brand-scoped
 * filter. An intentionally all-makes filter is a valid single official search
 * and must not be narrowed to an arbitrary mark (that would silently lose
 * listings).
 */
export function autoRiaIdentityIssues(
  filter: AutoRiaFilterIdentity,
  strategy: "public" | "api" = "api",
): AutoRiaPlanIssue[] {
  if (strategy === "public") {
    return [{
      level: "warning",
      message: "Публичный поиск AUTO.RIA не требует API-ключа; точность фильтра подтверждается локально, время публикации — по первому появлению",
    }];
  }
  if (!filter.brand && !filter.model && !filter.autoRiaMarkId && !filter.autoRiaModelId) {
    return [{
      level: "ok",
      message: "Любая марка: один официальный поиск AUTO.RIA без marka_id сохраняет полное покрытие",
    }];
  }

  const issues: AutoRiaPlanIssue[] = [];
  if (!filter.autoRiaMarkId) {
    issues.push({
      level: "danger",
      message: "Для указанной марки отсутствует официальный ID AUTO.RIA; контекст нельзя считать точным",
    });
    return issues;
  }

  if (filter.model && !filter.autoRiaModelId) {
    issues.push({
      level: "warning",
      message: "Модель указана текстом, но отсутствует официальный ID модели AUTO.RIA",
    });
  }
  return issues;
}

export function autoRiaRequestPlan(maxInfoPerScan: number, recentRequestCount?: number | null) {
  const maxDetails = Math.max(0, Math.trunc(maxInfoPerScan));
  return {
    expectedRequestsPerScan: 1,
    maximumRequestsPerScan: 1 + maxDetails,
    recentRequestsPerScan: recentRequestCount == null ? null : Math.max(0, Math.trunc(recentRequestCount)),
  };
}

export function autoRiaSearchBudgetPerHour(
  configuredSearchBudget: number,
  hourlyLimit: number,
  maxInfoPerScan: number,
): number {
  const limit = Math.max(1, Math.trunc(hourlyLimit));
  const detailsReserve = Math.min(Math.max(0, Math.trunc(maxInfoPerScan)), Math.max(0, limit - 1));
  return Math.max(1, Math.min(Math.trunc(configuredSearchBudget), limit - detailsReserve));
}

export function autoRiaRealtimeIntervalSeconds(input: {
  accessMode: "public" | "api";
  sourceIntervalSeconds: number;
  minimumIntervalSeconds: number;
  contextCount: number;
  hourlySearchBudget: number;
}): number {
  const configured = Math.max(1, input.sourceIntervalSeconds, input.minimumIntervalSeconds);
  if (input.accessMode === "public") return configured;
  const quotaSafe = Math.ceil((3600 * Math.max(1, input.contextCount)) / Math.max(1, input.hourlySearchBudget));
  return Math.max(configured, quotaSafe);
}
