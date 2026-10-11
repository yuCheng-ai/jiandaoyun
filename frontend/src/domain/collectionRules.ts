import type { CollectionRules } from "@platform/contracts";
export const collectionRuleLabels = {
  enabled: "收集状态",
  startsAt: "开始时间",
  endsAt: "截止时间",
  limit: "数量上限",
  allowRepeat: "重复提交",
} satisfies Record<keyof CollectionRules, string>;
export function localCollectionTime(value: string) {
  if (!value) return "";
  const date = new Date(value),
    two = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}${date.getMilliseconds() ? `.${String(date.getMilliseconds()).padStart(3, "0")}` : ""}`;
}
export function collectionInstant(value: string) {
  if (!value) return "";
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()))
    throw new Error("请填写有效的开始与截止时间。");
  return instant.toISOString();
}
/** Merge only independent edits. Shared-rule conflicts need an explicit choice before saving. */
export function mergeCollectionRules(
  base: CollectionRules,
  mine: CollectionRules,
  latest: CollectionRules,
) {
  const result = { ...latest };
  const conflicts: (keyof CollectionRules)[] = [];
  for (const key of Object.keys(
    collectionRuleLabels,
  ) as (keyof CollectionRules)[]) {
    if (mine[key] === base[key]) continue;
    if (latest[key] !== base[key] && latest[key] !== mine[key])
      conflicts.push(key);
    Object.assign(result, { [key]: mine[key] });
  }
  return { rules: result, conflicts };
}
export function collectionRuleDisplay(
  key: keyof CollectionRules,
  value: CollectionRules[keyof CollectionRules],
) {
  if (key === "enabled") return value ? "接受新提交" : "暂停收集";
  if (key === "allowRepeat")
    return value ? "允许重复提交" : "每位成员仅可提交一次";
  if (key === "limit") return value ? `${value} 条` : "不限";
  return value ? new Date(value as string).toLocaleString("zh-CN") : "不限";
}
