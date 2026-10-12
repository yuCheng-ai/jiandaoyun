import {
  isOrganizationField,
  groupActionNames,
  groupScopeNames,
  type DataFilter,
  type FormField,
  type FormSchema,
  type GroupedAccessConfig,
  type MigrationAccessSummary,
  type MigrationIdentityChoice,
  type MigrationResourceIssue,
  type PermissionGroup,
} from "@platform/contracts";
import { object } from "../../core/database/schema";

type Report = (
  kind: MigrationResourceIssue["kind"],
  message: string,
  groupId?: string,
  fieldId?: string,
) => void;
const fail = (message: string): never => {
  throw new Error(message);
};
const text = (value: unknown, label: string, max = 200): string =>
  typeof value === "string" &&
  value.length <= max &&
  !/[\u0000-\u001f]/.test(value)
    ? value
    : fail(`${label}格式不合法。`);
const flag = (value: unknown, fallback: boolean, label: string): boolean =>
  value === undefined
    ? fallback
    : typeof value === "boolean"
      ? value
      : fail(`${label}必须为开关值。`);
const keys = (
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail(`${label}包含尚未识别的配置，原始内容已保留。`);
};

/** Convert all saved rules, including disabled/archived groups. Never activate partially converted permissions. */
export function migrateAccess(
  formId: string,
  raw: unknown,
  schemas: FormSchema[],
  choices: MigrationIdentityChoice[],
  report: Report,
) {
  const summary: MigrationAccessSummary = {
    formId,
    checked: false,
    membersEnabled: null,
    publicEnabled: null,
    allowMerged: null,
    filling: null,
    groups: [],
    executionReady: false,
  };
  let problems = 0;
  const issue: Report = (kind, message, groupId, fieldId) => {
    problems++;
    report(kind, message, groupId, fieldId);
  };
  const definitions = new Map<
    string,
    { field: FormField; inRows: boolean }[]
  >();
  const visit = (fields: FormField[], depth = 0, inRows = false) => {
    if (!Array.isArray(fields) || depth > 10) return;
    for (const field of fields)
      if (field && typeof field.id === "string") {
        const list = definitions.get(field.id) || [];
        list.push({ field, inRows });
        definitions.set(field.id, list);
        visit(field.children, depth + 1, inRows || field.type === "subform");
      }
  };
  schemas.forEach((schema) => visit(schema?.fields));
  const mapped = (sourceId: string, kind?: MigrationIdentityChoice["kind"]) => {
    const matches = choices.filter(
      (choice) =>
        choice.sourceId === sourceId && (!kind || choice.kind === kind),
    );
    if (matches.length !== 1)
      fail("权限对象缺少唯一的身份类别对应，不能按名称或标识任选。");
    const choice = matches[0]!;
    if (choice.mode === "unresolved" || !choice.targetId)
      fail("权限引用的组织身份尚未明确对应。");
    return choice;
  };
  try {
    object(raw);
    keys(
      raw,
      ["membersEnabled", "publicEnabled", "allowMerged", "filling", "groups"],
      "访问权限",
    );
    summary.membersEnabled = flag(raw.membersEnabled, false, "成员入口");
    summary.publicEnabled = flag(raw.publicEnabled, true, "公开入口");
    summary.allowMerged = flag(raw.allowMerged, true, "权限合并");
    const filling = raw.filling === undefined ? {} : raw.filling;
    object(filling);
    keys(
      filling,
      ["enabled", "startsAt", "endsAt", "limit", "allowRepeat"],
      "收集规则",
    );
    const startsAt = text(filling.startsAt ?? "", "收集开始时间", 100),
      endsAt = text(filling.endsAt ?? "", "收集结束时间", 100),
      limit = filling.limit ?? 0;
    if (
      [startsAt, endsAt].some(
        (value) => value && !Number.isFinite(Date.parse(value)),
      ) ||
      (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt))
    )
      fail("收集时间范围无效。");
    if (!Number.isSafeInteger(limit) || limit < 0)
      fail("收集上限必须为非负整数，不能舍入或忽略。");
    summary.filling = {
      enabled: flag(filling.enabled, true, "收集状态"),
      startsAt,
      endsAt,
      limit,
      allowRepeat: flag(filling.allowRepeat, true, "重复填写"),
    };
    const groups = raw.groups === undefined ? [] : raw.groups;
    if (!Array.isArray(groups) || groups.length > 100)
      fail("权限组列表无效或超过 100 组，不能截断后迁移。");
    const duplicateIds = new Set(
      groups
        .filter(
          (group: any, index: number, all: any[]) =>
            group && all.findIndex((g) => g?.id === group.id) !== index,
        )
        .map((g: any) => g.id),
    );
    const converted: PermissionGroup[] = [];
    for (const rawGroup of groups) {
      let groupId: string | undefined;
      const start = problems;
      try {
        object(rawGroup);
        groupId = text(rawGroup.id, "权限组标识");
        if (!groupId || duplicateIds.has(groupId))
          fail("权限组标识缺失或重复，不能生成新标识绕过冲突。");
        const name = text(rawGroup.name ?? "", "权限组名称", 200),
          enabled = flag(rawGroup.enabled, false, "权限组启用"),
          archived = flag(rawGroup.archived, false, "权限组归档");
        keys(
          rawGroup,
          [
            "id",
            "name",
            "enabled",
            "archived",
            "identities",
            "actions",
            "filters",
            "scope",
            "fields",
          ],
          "权限组",
        );
        if (
          !Array.isArray(rawGroup.actions) ||
          rawGroup.actions.some(
            (action: any) =>
              typeof action !== "string" ||
              !Object.hasOwn(groupActionNames, action),
          ) ||
          new Set(rawGroup.actions).size !== rawGroup.actions.length
        )
          fail("操作权限包含重复或未支持的操作。");
        if (
          rawGroup.actions.some(
            (action: string) => !["view", "create"].includes(action),
          ) &&
          !rawGroup.actions.includes("view")
        )
          fail("管理已有记录的操作缺少查看权限。");
        if (
          typeof rawGroup.scope !== "string" ||
          !Object.hasOwn(groupScopeNames, rawGroup.scope)
        )
          fail("记录范围无效，不能默认放宽为全部记录。");
        if (
          !Array.isArray(rawGroup.identities) ||
          rawGroup.identities.some(
            (id: any) => typeof id !== "string" || !id,
          ) ||
          new Set(rawGroup.identities).size !== rawGroup.identities.length
        )
          fail("权限对象列表无效或重复。");
        if (
          !archived &&
          (!name.trim() ||
            !rawGroup.identities.length ||
            !rawGroup.actions.length)
        )
          issue(
            "invalid",
            "未归档权限组需要名称、权限对象和操作权限。",
            groupId,
          );
        const subjects: PermissionGroup["subjects"] = [];
        for (const identity of rawGroup.identities)
          try {
            const choice = mapped(identity);
            subjects.push({
              kind: choice.kind,
              id: choice.targetId!,
              sourceId: choice.sourceId,
              historical: choice.mode === "historical",
              ...(choice.kind === "department"
                ? { includeChildren: true }
                : {}),
            });
          } catch (cause) {
            issue("mapping", (cause as Error).message, groupId);
          }
        object(rawGroup.fields);
        const fields: PermissionGroup["fields"] = Object.create(null);
        for (const [id, value] of Object.entries(rawGroup.fields)) {
          if (!definitions.has(id)) {
            issue(
              "invalid",
              "权限字段在已保留的草稿和发布版本中均不存在。",
              groupId,
              id,
            );
            continue;
          }
          if (
            typeof value !== "string" ||
            !["hidden", "read", "edit"].includes(value)
          ) {
            issue("invalid", "字段权限值不合法。", groupId, id);
            continue;
          }
          fields[id] = value as PermissionGroup["fields"][string];
        }
        if (!Array.isArray(rawGroup.filters) || rawGroup.filters.length > 100)
          fail("权限筛选条件列表无效或超过检查容量。");
        const filterIds = new Set<string>(),
          filters: DataFilter[] = [];
        for (const rawFilter of rawGroup.filters)
          try {
            object(rawFilter);
            keys(
              rawFilter,
              ["id", "sourceFieldId", "operator", "source", "value"],
              "权限筛选",
            );
            const id = text(rawFilter.id, "筛选标识"),
              sourceFieldId = text(rawFilter.sourceFieldId, "筛选字段");
            if (!id || filterIds.has(id)) fail("权限筛选标识缺失或重复。");
            filterIds.add(id);
            if (
              ![
                "equals",
                "notEquals",
                "contains",
                "greater",
                "less",
                "notEmpty",
              ].includes(rawFilter.operator) ||
              !["constant", "currentUser", "currentDepartment"].includes(
                rawFilter.source,
              )
            )
              fail("权限筛选类型不支持，不能移除条件后扩大范围。");
            const variants = definitions.get(sourceFieldId) || [];
            if (
              !variants.length ||
              variants.some(
                ({ field, inRows }) =>
                  inRows ||
                  field.children?.length ||
                  ["subform", "tabs", "divider", "button"].includes(field.type),
              )
            )
              fail("权限筛选字段不存在或不是主记录中的值字段。");
            if (
              rawFilter.source !== "constant" &&
              rawFilter.operator !== "notEmpty"
            ) {
              const expected =
                rawFilter.source === "currentUser" ? "member" : "department";
              if (
                !variants.every(
                  ({ field }) =>
                    isOrganizationField(field.type) &&
                    (field.type.startsWith("department")
                      ? "department"
                      : "member") === expected,
                )
              )
                fail(
                  "当前身份筛选与字段身份类型不一致，不能在身份转换后改变匹配含义。",
                );
            }
            let value = rawFilter.value ?? "";
            if (typeof value !== "string" || value.length > 10000)
              fail("筛选值格式不合法。");
            if (
              rawFilter.source === "constant" &&
              rawFilter.operator !== "notEmpty" &&
              !value.trim()
            )
              fail("权限筛选常量未填写。");
            if (
              rawFilter.source === "constant" &&
              value &&
              rawFilter.operator !== "notEmpty" &&
              variants.some(({ field }) => isOrganizationField(field.type))
            ) {
              if (
                !variants.every(({ field }) => isOrganizationField(field.type))
              )
                fail("筛选字段在历史版本中的身份语义不同，不能统一替换常量。");
              const kinds = new Set(
                variants.map(({ field }) =>
                  field.type.startsWith("department") ? "department" : "member",
                ),
              );
              if (kinds.size !== 1) fail("筛选字段的历史身份类别不同。");
              if (!["equals", "notEquals"].includes(rawFilter.operator))
                fail(
                  "组织身份的文本或数值筛选不能直接替换标识，需核对原条件。",
                );
              try {
                value = mapped(
                  value,
                  [...kinds][0] as "member" | "department",
                ).targetId!;
              } catch (cause) {
                issue(
                  "mapping",
                  (cause as Error).message,
                  groupId,
                  sourceFieldId,
                );
                continue;
              }
            }
            filters.push({
              id,
              sourceFieldId,
              operator: rawFilter.operator,
              source: rawFilter.source,
              value,
            });
          } catch (cause) {
            issue("invalid", (cause as Error).message, groupId);
          }
        if (rawGroup.scope === "custom" && !rawGroup.filters.length)
          issue(
            "invalid",
            "自定义记录范围没有筛选条件，不能按全部记录处理。",
            groupId,
          );
        summary.groups.push({
          id: groupId,
          name,
          enabled,
          archived,
          checked: problems === start,
          actions: [...rawGroup.actions],
          scope: rawGroup.scope,
          subjects: rawGroup.identities.length,
          mappedSubjects: subjects.length,
          historicalSubjects: subjects.filter((s) => s.historical).length,
          fields: Object.keys(rawGroup.fields).length,
          filters: rawGroup.filters.length,
        });
        if (problems === start)
          converted.push({
            id: groupId,
            name,
            enabled,
            archived,
            subjects,
            actions: [...rawGroup.actions],
            scope: rawGroup.scope,
            departmentBasis: "record-created",
            departmentIncludesChildren: false,
            filters,
            fields,
          });
      } catch (cause) {
        issue("invalid", (cause as Error).message, groupId);
        summary.groups.push({
          id: groupId || `invalid-${summary.groups.length}`,
          name:
            typeof rawGroup?.name === "string"
              ? rawGroup.name.slice(0, 200)
              : "未命名权限组",
          enabled:
            typeof rawGroup?.enabled === "boolean" ? rawGroup.enabled : null,
          archived:
            typeof rawGroup?.archived === "boolean" ? rawGroup.archived : null,
          checked: false,
          actions: [],
          scope: null,
          subjects: 0,
          mappedSubjects: 0,
          historicalSubjects: 0,
          fields: 0,
          filters: 0,
        });
      }
    }
    summary.checked = problems === 0;
    const config: GroupedAccessConfig | undefined = summary.checked
      ? {
          version: 1,
          membersEnabled: summary.membersEnabled,
          publicEnabled: summary.publicEnabled,
          allowMerged: summary.allowMerged,
          selectionMode: "explicit-or-allowed-merge",
          actionFieldMode: "same-record-scoped-group",
          creationFieldMode: "published-page-and-start-node",
          filling: summary.filling,
          groups: converted,
        }
      : undefined;
    return { summary, config };
  } catch (cause) {
    issue("invalid", (cause as Error).message);
    return { summary, config: undefined };
  }
}
