import {
  defaultAccess,
  memberActions,
  parseAccess,
  type AccessGroup,
  type FormAccess,
} from "./access";
import { checkedDraftValue } from "./editorDrafts";
import { parseFilters } from "./fieldConfig";

function object(value: unknown): Record<string, any> {
  const raw = checkedDraftValue(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("访问设置暂存格式无效");
  return raw as Record<string, any>;
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string") &&
  new Set(value).size === value.length;
const booleans = (raw: Record<string, any>, keys: string[]) =>
  keys.every((key) => typeof raw[key] === "boolean");

/** Restore unfinished input without normalizing it into broader permissions or default limits. */
export function restoreAccessGroupDraft(
  value: unknown,
  expectedId?: string,
): AccessGroup {
  const raw = object(value);
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    (expectedId && expectedId !== raw.id)
  )
    throw Error("权限组暂存不属于此配置");
  if (
    typeof raw.name !== "string" ||
    raw.name.length > 60 ||
    !booleans(raw, ["enabled", "archived"]) ||
    !strings(raw.identities) ||
    !strings(raw.actions) ||
    raw.actions.some((action) => !Object.hasOwn(memberActions, action)) ||
    !["all", "self", "department", "custom"].includes(raw.scope) ||
    !raw.fields ||
    typeof raw.fields !== "object" ||
    Array.isArray(raw.fields) ||
    Object.values(raw.fields).some(
      (value) => !["hidden", "read", "edit"].includes(String(value)),
    ) ||
    !Array.isArray(raw.filters) ||
    raw.filters.some(
      (filter: any) =>
        !filter ||
        typeof filter.sourceFieldId !== "string" ||
        typeof filter.value !== "string",
    ) ||
    parseFilters(raw.filters).length !== raw.filters.length
  )
    throw Error("权限组成员、字段权限或筛选条件暂存格式无效");
  return parseAccess({ ...defaultAccess(), groups: [raw] }).groups[0]!;
}

export function restoreAccessSettingsDraft(value: unknown): FormAccess {
  const raw = object(value),
    filling = object(raw.filling);
  if (
    !booleans(raw, ["membersEnabled", "publicEnabled", "allowMerged"]) ||
    !booleans(filling, ["enabled", "allowRepeat"]) ||
    typeof filling.startsAt !== "string" ||
    typeof filling.endsAt !== "string" ||
    (filling.limit !== "" &&
      (typeof filling.limit !== "number" || !Number.isFinite(filling.limit))) ||
    !Array.isArray(raw.groups) ||
    raw.groups.length > 100
  )
    throw Error("发布设置暂存格式无效");
  const groups = raw.groups.map((group: unknown) =>
    restoreAccessGroupDraft(group),
  );
  if (
    new Set(groups.map((group: AccessGroup) => group.id)).size !== groups.length
  )
    throw Error("权限组身份重复");
  const config = parseAccess({ ...raw, groups });
  // An empty or invalid numeric input remains editable; accessIssues rejects it on save.
  config.filling.limit = filling.limit;
  return config;
}
