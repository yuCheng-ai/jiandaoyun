import { computed, inject, type ComputedRef, type InjectionKey } from "vue";
import type { WorkspaceData } from "../domain/workspace";
import { useWorkspaceStore } from "../stores/workspace";
export const runtimeDataKey: InjectionKey<ComputedRef<WorkspaceData>> =
  Symbol("runtimeData");
/** A member preview supplies its identity and permitted relation candidates to all field controls. */
export function useRuntimeData() {
  const provided = inject(runtimeDataKey, undefined);
  if (provided) return provided;
  const store = useWorkspaceStore();
  return computed(() => store.data);
}
