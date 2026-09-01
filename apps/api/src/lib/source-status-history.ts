export function mergeRecentRunsBySource<T extends { startedAt: Date }>(
  runsBySource: readonly (readonly T[])[],
): T[] {
  return runsBySource
    .flatMap((runs) => [...runs])
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime());
}

export function mergeIncidentHistory<T extends { id: string }>(
  active: readonly T[],
  resolved: readonly T[],
): T[] {
  const activeIds = new Set(active.map((incident) => incident.id));
  return [
    ...active,
    ...resolved.filter((incident) => !activeIds.has(incident.id)),
  ];
}

export function latestActiveIncidentPerSource<
  T extends { sourceId: string; updatedAt: Date },
>(incidents: readonly T[]): T[] {
  const latestBySource = new Map<string, T>();
  for (const incident of incidents) {
    const current = latestBySource.get(incident.sourceId);
    if (!current || incident.updatedAt.getTime() > current.updatedAt.getTime()) {
      latestBySource.set(incident.sourceId, incident);
    }
  }
  return [...latestBySource.values()]
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}
