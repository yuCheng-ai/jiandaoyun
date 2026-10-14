import { computed, inject, type ComputedRef, type InjectionKey } from "vue";
import { emptyWorkspace, type WorkspaceData } from "../domain/workspace";
export const runtimeDataKey: InjectionKey<ComputedRef<WorkspaceData>> =
  Symbol("runtimeData");
/** 表单容器提供当前可用数据；独立控件不再隐式读取旧浏览器业务仓库。 */
export function useRuntimeData() {
  const provided = inject(runtimeDataKey, undefined);
  if (provided) return provided;
  const empty = emptyWorkspace();
  return computed(() => empty);
}
