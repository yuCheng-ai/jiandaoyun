import { computed, inject, type ComputedRef, type InjectionKey } from "vue";
import type { WorkspaceData } from "../domain/workspace";
import { useWorkspaceStore } from "../stores/workspace";
export const runtimeDataKey: InjectionKey<ComputedRef<WorkspaceData>> =
  Symbol("runtimeData");
/** A member preview supplies its identity and permitted relation candidates to all field controls. */
export function useRuntimeData() {
  const store = useWorkspaceStore();
  return inject(
    runtimeDataKey,
    computed(() => store.data),
  );
}
