import type { RecordGroupOptions } from "@platform/contracts";
import { platformApi } from "./platformApi";
import { accessGroupSelections } from "./accessGroupState";
export { accessGroupSelections, chooseAccessGroup } from "./accessGroupState";
export async function recordGroupOptions(
  id: string,
): Promise<RecordGroupOptions> {
  const result = await platformApi<RecordGroupOptions>(
    `/definitions/${id}/permission-groups/options`,
  );
  if (
    !result ||
    typeof result.administrator !== "boolean" ||
    !Array.isArray(result.groups)
  )
    throw new Error("权限组信息未能正确读取，请刷新后重试。");
  return result;
}
export const accessGroupReady = (id: string, options: RecordGroupOptions) =>
  options.administrator || !!accessGroupSelections.value[id];
