export type SourceSearchStateHygieneRow = {
  id: string;
  source: string;
  fingerprint: string;
  filterIds: readonly string[];
  updatedAt: Date;
};

export type SourceSearchStateHygieneOptions = {
  source?: string;
  preserveStateId?: string;
  currentFingerprints?: readonly string[];
};

export type SourceSearchStateHygieneSelection = {
  deleteIds: string[];
  planReady: boolean;
};

/**
 * Selects only states that can no longer be referenced by the active plan.
 * A plan-based sweep starts only after all replacement fingerprints exist, so
 * cursor continuity is never discarded before its successor is persisted.
 */
export function selectSourceSearchStateIdsToDelete(
  states: readonly SourceSearchStateHygieneRow[],
  enabledFilterIds: ReadonlySet<string>,
  options: SourceSearchStateHygieneOptions = {},
): SourceSearchStateHygieneSelection {
  const scopedStates = options.source ? states.filter((state) => state.source === options.source) : [...states];
  const deleteIds = new Set<string>();

  for (const state of scopedStates) {
    const filterIds = uniqueSorted(state.filterIds);
    if (filterIds.length === 0 || filterIds.every((filterId) => !enabledFilterIds.has(filterId))) {
      deleteIds.add(state.id);
    }
  }

  const usableStates = scopedStates.filter((state) => !deleteIds.has(state.id));
  const currentFingerprints = options.currentFingerprints == null
    ? undefined
    : new Set(options.currentFingerprints);
  const planReady = currentFingerprints == null
    ? true
    : [...currentFingerprints].every((fingerprint) => usableStates.some((state) => state.fingerprint === fingerprint));

  if (currentFingerprints && planReady) {
    for (const state of usableStates) {
      if (!currentFingerprints.has(state.fingerprint)) deleteIds.add(state.id);
    }
  }

  const groups = new Map<string, SourceSearchStateHygieneRow[]>();
  for (const state of usableStates) {
    if (deleteIds.has(state.id)) continue;
    const key = `${state.source}\u001f${uniqueSorted(state.filterIds).join("\u001f")}`;
    const group = groups.get(key) ?? [];
    group.push(state);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const preserved = group.find((state) => state.id === options.preserveStateId)
      ?? [...group].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id))[0];
    for (const state of group) {
      if (state.id !== preserved?.id) deleteIds.add(state.id);
    }
  }

  return { deleteIds: [...deleteIds].sort((a, b) => a.localeCompare(b)), planReady };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
