import { parseWorkspace, WORKSPACE_KEY } from "./workspaceRepository";

export function migrationSourceStamp(
  storage: Pick<Storage, "getItem"> = localStorage,
) {
  return storage.getItem(WORKSPACE_KEY);
}

/** Check original array cardinalities before using the normal compatibility reader.
 * The migration inventory must never silently omit entries or truncate old configuration.
 */
function checkArrays(source: unknown, parsed: unknown, path = "应用内容") {
  if (Array.isArray(source)) {
    if (!Array.isArray(parsed) || source.length !== parsed.length)
      throw new Error(`${path} 无法完整读取，迁移检查已停止；原数据保留。`);
    source.forEach((value, index) =>
      checkArrays(value, parsed[index], `${path} / ${index + 1}`),
    );
  } else if (source && typeof source === "object") {
    const target =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(source)) {
      // Recent navigation is an advisory cache, not a business resource to migrate.
      if (path === "应用内容" && key === "recentFormIds") continue;
      checkArrays(value, target[key], `${path} / ${key}`);
    }
  }
}

export function readApplicationMigrationSource(
  storage: Pick<Storage, "getItem"> = localStorage,
) {
  const stamp = migrationSourceStamp(storage);
  if (stamp === null)
    throw new Error("还没有已保存的应用内容，请先保存应用后再检查。");
  const original: unknown = JSON.parse(stamp);
  const data = parseWorkspace(stamp);
  checkArrays(original, data);
  return { data, stamp };
}
