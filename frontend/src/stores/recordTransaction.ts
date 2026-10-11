import { copy } from "../domain/form";
import type { FormEntry, WorkspaceData } from "../domain/workspace";

function restoreEntry(target: FormEntry, value: FormEntry) {
  for (const key of Object.keys(target))
    if (!(key in value)) delete (target as any)[key];
  Object.assign(target, value);
}
/** Preserve object identity while rolling back source, derived records and execution logs. */
export function recordCheckpoint(data: WorkspaceData) {
  const entries = [...data.entries],
    values = entries.map(copy),
    runs = data.extensionRuns,
    orders = data.paymentOrders,
    counters = data.serialCounters;
  return () => {
    entries.forEach((e, i) => restoreEntry(e, values[i]!));
    data.entries = entries;
    data.extensionRuns = runs;
    data.paymentOrders = orders;
    data.serialCounters = counters;
  };
}
export function commitAutomationEntries(
  data: WorkspaceData,
  entries: FormEntry[],
) {
  for (const value of entries) {
    const existing = data.entries.find((e) => e.id === value.id);
    if (existing) restoreEntry(existing, value);
    else data.entries.unshift(value);
  }
}
