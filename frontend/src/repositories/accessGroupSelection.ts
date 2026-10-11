import type { RecordGroupOptions } from "@platform/contracts";
import { platformApi } from "./platformApi";
import { accessGroupSelections, chooseAccessGroup } from "./accessGroupState";
export { accessGroupSelections, chooseAccessGroup } from "./accessGroupState";
export async function recordGroupOptions(
  id: string,
): Promise<RecordGroupOptions> {
  const result = await platformApi<RecordGroupOptions>(
    `/definitions/${id}/permission-groups/options`,
  );
  if (
    !result ||
    !["direct", "groups"].includes(result.mode) ||
    !Array.isArray(result.groups)
  )
    throw new Error("权限组信息未能正确读取，请刷新后重试。");
  const options = result;
  const current = accessGroupSelections.value[id];
  if (options.mode !== "groups") chooseAccessGroup(id, "");
  else if (
    !options.groups.some((group) => group.id === current) &&
    !(current === "*" && (options.allowMerged || options.groups.length === 1))
  )
    chooseAccessGroup(
      id,
      options.groups.length === 1 ? options.groups[0]!.id : "",
    );
  return options;
}
export const accessGroupReady = (id: string, options: RecordGroupOptions) =>
  options.mode === "direct" || !!accessGroupSelections.value[id];
