import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  isOrganizationField,
  emptyFieldValue,
  fieldDefaultValue,
  textFormats,
  dataFields,
  dataModelChanges,
  modelFormSchema,
  type ServerOrganization,
  type DataModel,
  type DataModelImpact,
  type ModelFieldChange,
  type ProcessTemplateSpec,
} from "@platform/contracts";
import type { Transaction } from "../../core/database/database";
import { pageBindings } from "./page-schema";
import { referencedRelationFields } from "../relations/relation-rules";
import { allFields, scalar } from "../../core/database/schema";
import { organizationCandidates, organizationDefaultResolver } from "../directory/organization-fields";

// ============================================================================
// 1. 字段设置差异格式化辅助函数
// ============================================================================

/** 递归将对象属性按字典序排列，用于生成稳定的对比指纹 */
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

const fingerprint = (value: unknown) => JSON.stringify(canonical(value));

const SETTING_NAMES: Record<string, string> = {
  defaultValue: "默认值",
  defaultFormula: "默认值方式",
  expression: "公式",
  formulaRemark: "公式备注",
  dateDefault: "默认值来源",
  min: "最小值",
  max: "最大值",
  precision: "小数位",
  retainPrecision: "保留小数位数",
  numberGrouping: "显示千分符",
  limitRange: "限定数值范围",
  maxLength: "文本长度",
  unique: "唯一性",
  options: "选项",
  format: "格式",
  choiceSource: "选项来源",
  organization: "组织选择规则",
};

const FORMAT_LABELS: Record<string, string> = {
  none: "普通文本",
  number: "数值",
  percent: "百分比",
  email: "邮箱",
  month: "年-月",
  date: "年-月-日",
  "datetime-local": "年-月-日 时:分",
  "datetime-second": "年-月-日 时:分:秒",
};

const display = (value: unknown) =>
  value === undefined || value === null || value === "" ? "未设置" : JSON.stringify(value);

/** 将字段配置项的值转换为可读的中文说明 */
function displaySetting(
  key: string,
  value: unknown,
  field: ReturnType<typeof dataFields>[number]["field"],
  identityNames: Map<string, string>,
  fieldNames: Map<string, string>,
): string {
  if (key === "organization") {
    const config = value as any;
    if (!config) return "未设置";

    const rangeMap: Record<string, string> = {
      all: "全部",
      custom: "指定范围",
      currentDepartment: "当前成员所在部门",
      fieldDepartment: "由部门字段决定",
    };
    const initialMap: Record<string, string> = {
      none: config.defaultIds.length ? "指定身份" : "无",
      currentUser: "当前成员",
      currentDepartment: "当前成员主部门",
      departmentManager: "主部门负责人",
    };

    const range = rangeMap[config.scope.mode];
    const initial = initialMap[config.defaultMode];
    const specified = [
      ...config.scope.departmentIds,
      ...config.scope.employeeIds,
      ...config.scope.roleIds,
    ]
      .map((id) => identityNames.get(id) || "已不可用身份")
      .join("、");
    const defaults = config.defaultIds
      .map((id: string) => identityNames.get(id) || "已不可用身份")
      .join("、");

    let scopeDetail = "";
    if (config.scope.mode === "custom") {
      scopeDetail = `（${specified || "空范围"}）`;
    } else if (config.scope.mode === "fieldDepartment") {
      scopeDetail = `（${fieldNames.get(config.scope.fieldId) || "未选择"}）`;
    }

    const childrenText = config.scope.includeChildren ? "含下级部门" : "不含下级部门";
    const defaultDetail = config.defaultMode === "none" && defaults ? `（${defaults}）` : "";

    return `${range}${scopeDetail}，${childrenText}，默认${initial}${defaultDetail}`;
  }

  if (key === "options") {
    return field.settings.options?.map((option) => option.label).join("、") || "无选项";
  }

  if (key === "defaultValue" && ["choice", "choices"].includes(field.kind)) {
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    const labels = selected
      .map((id) => field.settings.options.find((option) => option.id === id)?.label || "已失效选项")
      .join("、");
    return labels || "未设置";
  }

  if (key === "format") {
    return (
      FORMAT_LABELS[String(value)] ||
      textFormats.find((item) => item.value === value)?.label ||
      display(value)
    );
  }

  if (key === "defaultFormula") return value ? "公式编辑" : "自定义";

  if (key === "expression" && typeof value === "string") {
    return value.replace(
      /\{\{([a-zA-Z0-9_.:-]+)\}\}/g,
      (_, id) => fieldNames.get(id) || "已失效字段",
    );
  }

  if (key === "dateDefault") return value === "now" ? "填写当时" : "自定义";

  if (["retainPrecision", "numberGrouping", "limitRange"].includes(key)) {
    if (value === undefined) return "原设置";
    return value ? "开启" : "关闭";
  }

  if (key === "choiceSource" && field.settings.choiceSource?.mode === "manual") {
    return "自定义选项";
  }

  return display(value);
}

// ============================================================================
// 2. 数据模型发布影响评估核心
// ============================================================================

/**
 * 评估数据对象模型（DataModel）发布对页面、关联关系、流程模板、权限配置及存量记录的影响
 * （仅返回配置与聚合计数，绝不暴露具体记录内容或记录 ID）
 */
export async function dataModelImpact(
  tx: Transaction,
  definition: any,
  model: DataModel,
  managePage = false,
  context?: { organization: ServerOrganization; actorId: string; publishingPageId?: string },
): Promise<DataModelImpact> {
  const prevSql = `
    SELECT v.title, m.model
    FROM data_object_versions m
    JOIN definition_versions v USING (definition_id, version)
    WHERE m.definition_id = $1 AND m.version = $2
  `;
  const previous = (await tx.query(prevSql, [definition.id, definition.latest_version])).rows[0];
  const before: DataModel = previous?.model || { version: 1, fields: [] };

  const changes = dataModelChanges(before, model);
  const old = new Map(dataFields(before).map((item) => [item.field.id, item]));
  const nextIds = new Set(dataFields(model).map((item) => item.field.id));

  const allRootFields = [...model.fields, ...before.fields];
  const names = new Map(
    [...dataFields(before), ...dataFields(model)].map((item) => {
      const label = item.parentId
        ? `${allRootFields.find((f) => f.id === item.parentId)!.name} / ${item.field.name}`
        : item.field.name;
      return [item.field.id, label];
    }),
  );

  const identityNames = new Map(
    [
      ...(context?.organization.users || []),
      ...(context?.organization.spec.departments || []),
      ...(context?.organization.spec.roles || []),
    ].map((item) => [item.id, item.name]),
  );

  const summarize = (item: ReturnType<typeof dataFields>[number]): ModelFieldChange => {
    const prior = old.get(item.field.id);
    const details: string[] = [];

    if (prior) {
      if (prior.field.required !== item.field.required) {
        details.push(
          `永久必填：${prior.field.required ? "是" : "否"} → ${item.field.required ? "是" : "否"}`,
        );
      }
      const settingKeys = new Set([
        ...Object.keys(prior.field.settings),
        ...Object.keys(item.field.settings),
      ]);
      for (const key of settingKeys) {
        const a = (prior.field.settings as any)[key];
        const b = (item.field.settings as any)[key];
        if (fingerprint(a) !== fingerprint(b)) {
          const beforeText = displaySetting(key, a, prior.field, identityNames, names);
          const afterText = displaySetting(key, b, item.field, identityNames, names);
          details.push(`${SETTING_NAMES[key] || key}：${beforeText} → ${afterText}`);
        }
      }
    } else if (item.field.required) {
      details.push("新增永久必填字段");
    }

    return {
      id: item.field.id,
      name: item.field.name,
      ...(item.parentId
        ? { parentName: allRootFields.find((f) => f.id === item.parentId)!.name }
        : {}),
      ...(prior && prior.field.name !== item.field.name ? { beforeName: prior.field.name } : {}),
      details,
    };
  };

  const affected = new Set(
    [...changes.removed, ...changes.changed, ...changes.renamed].map((item) => item.field.id),
  );
  const references: DataModelImpact["references"] = [];
  const stamps: unknown[] = [];
  let defaultPageWillPublish = false;

  const referenced = (ids: Iterable<string>) =>
    [...ids].filter((id) => affected.has(id)).map((id) => names.get(id) || id);
  const missing = (ids: Iterable<string>) => [...ids].filter((id) => !nextIds.has(id));

  // 1. 检查关联页面的绑定与阻塞情况
  const pageSql = `
    SELECT p.*, v.title AS public_title, v.schema, v.definition_version AS public_data_version
    FROM pages p
    LEFT JOIN page_versions v ON v.page_id = p.id AND v.version = p.latest_version
    WHERE p.definition_id = $1
    ORDER BY p.id
  `;
  const { rows: pageRows } = await tx.query(pageSql, [definition.id]);
  for (const row of pageRows) {
    stamps.push(["page", row.id, row.revision]);
    // 当前正在随同模型一起发布的页面不计入外部阻塞引用
    if (row.id === context?.publishingPageId) continue;

    if (managePage && row.managed && !row.archived_at) {
      defaultPageWillPublish = true;
    }

    if (row.latest_version) {
      const ids = pageBindings(row.schema);
      const blocked = !row.archived_at && missing(ids).length > 0 && !(managePage && row.managed);

      let detail: string;
      if (row.archived_at) {
        detail = `页面已归档，保留数据 V${row.public_data_version} 的历史绑定；恢复前检查字段差异`;
      } else if (blocked) {
        const missingNames = missing(ids)
          .map((id) => names.get(id) || id)
          .join("、");
        detail = `仍使用待移除字段：${missingNames}；请先调整并发布页面`;
      } else if (managePage && row.managed) {
        detail = "默认页面随此兼容定义一起发布；历史页面保留";
      } else {
        detail = `保持数据 V${row.public_data_version}；采用新版需要重新编辑并发布`;
      }

      references.push({
        kind: "page",
        id: row.id,
        title: row.public_title,
        state: "published",
        version: row.latest_version,
        fields: referenced(ids),
        effect: blocked ? "blocks" : "retained",
        detail,
      });
    }

    const hasDraftDiff =
      !row.latest_version ||
      row.title !== row.public_title ||
      row.definition_version !== row.public_data_version ||
      fingerprint(row.draft) !== fingerprint(row.schema) ||
      row.additions.length;

    if (hasDraftDiff) {
      const ids = pageBindings(row.draft);
      const detail = row.additions.length
        ? `含 ${row.additions.length} 项待发布字段变更；模型发布后需重新核对数据基线`
        : "页面草稿保留原版本；采用新版时需处理字段差异";

      references.push({
        kind: "page",
        id: row.id,
        title: row.title,
        state: "draft",
        version: row.latest_version,
        fields: referenced(ids),
        effect: "review",
        detail,
      });
    }
  }

  // 2. 检查跨表关联关系引用
  const relationSql = `
    SELECT d.*, v.spec
    FROM relation_definitions d
    LEFT JOIN relation_versions v ON v.relation_id = d.id AND v.version = d.latest_version
    WHERE d.source_definition_id = $1 OR d.target_definition_id = $1
    ORDER BY d.id
  `;
  const { rows: relationRows } = await tx.query(relationSql, [definition.id]);
  for (const row of relationRows) {
    stamps.push(["relation", row.id, row.revision]);
    const addRelationRef = (spec: any, state: "draft" | "published") => {
      const ids = referencedRelationFields(spec, definition.id);
      const blocked = state === "published" && missing(ids).length > 0;
      const missingNames = missing(ids)
        .map((id) => names.get(id) || id)
        .join("、");
      const detail = blocked
        ? `仍引用待移除字段：${missingNames}；请先调整并发布关系`
        : "关系读取两端的已发布字段；检查筛选、展示和回填是否符合新规则";

      references.push({
        kind: "relation",
        id: row.id,
        title: spec.title,
        state,
        version: row.latest_version,
        fields: referenced(ids),
        effect: blocked ? "blocks" : "review",
        detail,
      });
    };

    if (row.spec) addRelationRef(row.spec, "published");
    if (!row.spec || fingerprint(row.spec) !== fingerprint(row.draft)) {
      addRelationRef(row.draft, "draft");
    }
  }

  // 3. 检查流程模板引用
  const processSql = `
    SELECT t.*, v.spec
    FROM process_templates t
    LEFT JOIN process_template_versions v ON v.template_id = t.id AND v.version = t.latest_version
    WHERE t.workspace_id = $1
    ORDER BY t.id
  `;
  const { rows: processRows } = await tx.query(processSql, [definition.workspace_id]);
  for (const row of processRows) {
    const addProcessRef = (spec: ProcessTemplateSpec, state: "draft" | "published") => {
      const bindings = spec.bindings.filter((binding) => binding.definitionId === definition.id);
      if (!bindings.length) return;

      stamps.push(["process", row.id, row.revision, state]);
      const bindingIds = new Set(bindings.map((b) => b.id));
      const ids = new Set<string>();

      for (const task of spec.tasks) {
        if (bindingIds.has(task.recordBinding)) {
          task.requiredFields.forEach((id) => ids.add(id));
          if (task.subformId) ids.add(task.subformId);
        }
        if (task.waitFor && bindingIds.has(task.waitFor.recordBinding)) {
          ids.add(task.waitFor.fieldId);
          if (task.waitFor.subformId) ids.add(task.waitFor.subformId);
        }
      }

      const bindingSummary = bindings
        .map((b) => `${b.title}：数据 V${b.definitionVersion}`)
        .join("；");
      references.push({
        kind: "process",
        id: row.id,
        title: spec.title,
        state,
        version: row.latest_version,
        fields: referenced(ids),
        effect: "retained",
        detail: `${bindingSummary}。任务范围、必填和等待条件继续按绑定版本执行`,
      });
    };

    if (row.spec) addProcessRef(row.spec, "published");
    if (!row.spec || fingerprint(row.spec) !== fingerprint(row.draft)) {
      addProcessRef(row.draft, "draft");
    }
  }

  // 4. 检查常规权限策略与权限组引用
  const orgRes = await tx.query(
    "SELECT revision, spec FROM workspace_organizations WHERE workspace_id = $1",
    [definition.workspace_id],
  );
  const organization = orgRes.rows[0];
  stamps.push(["organization", organization?.revision]);

  const groupRes = await tx.query(
    "SELECT config, revision FROM record_permission_groups WHERE definition_id = $1",
    [definition.id],
  );
  const groupRow = groupRes.rows[0];
  if (groupRow) {
    stamps.push(["permission-groups", groupRow.revision]);
    for (const group of groupRow.config.groups) {
      const filters = group.filters.map((filter: { sourceFieldId: string }) => filter.sourceFieldId);
      const active = group.enabled && !group.archived;
      const blocked =
        active && group.actions.includes("view") && group.scope === "custom" && missing(filters).length > 0;
      const detail = blocked
        ? "使用中的自定义记录范围引用了待移除字段，请先调整权限组条件"
        : "字段授权及范围条件按稳定身份保留；新增字段默认隐藏，历史版本继续单独计算权限";

      references.push({
        kind: "permission",
        id: `group:${group.id}`,
        title: `权限组 · ${group.name}`,
        state: "published",
        version: groupRow.revision,
        fields: referenced([...Object.keys(group.fields), ...filters]),
        effect: blocked ? "blocks" : "retained",
        detail,
      });
    }
  }

  // 5. 统计存量记录并在有界游标中分批校验存量记录对新字段约束的兼容性
  const recordCountSql =
    "SELECT definition_version AS version,count(*) FILTER (WHERE archived_at IS NULL)::int AS count," +
    "count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived " +
    "FROM records WHERE definition_id=$1 GROUP BY definition_version ORDER BY definition_version";
  const { rows: recordCountRows } = await tx.query(recordCountSql, [definition.id]);
  const records: DataModelImpact["records"] = recordCountRows.map((row) => ({
    ...row,
    incompatible: 0,
  }));

  const runtime = new Map(allFields(modelFormSchema(model)).map((field) => [field.id, field]));
  const toCheck = [...changes.added, ...changes.changed];
  const checksOrganization = toCheck.some((item) => isOrganizationField(item.field.kind));
  if (checksOrganization && context) {
    stamps.push([
      "identities",
      context.organization.users.map((user) => [user.id, user.name, user.active]),
    ]);
  }

  // 分批游标扫描，控制大表内存占用；仅向外输出不兼容记录计数
  if (toCheck.length) {
    let cursor: string | null = null;
    for (;;) {
      const batchSql = `
        SELECT id, definition_version, values, state
        FROM records
        WHERE definition_id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id > $2)
        ORDER BY id
        LIMIT 500
      `;
      const { rows }: { rows: any[] } = await tx.query(batchSql, [definition.id, cursor]);
      if (!rows.length) break;

      for (const row of rows) {
        const invalid = toCheck.some((item) => {
          const originalField = runtime.get(item.field.id)!;
          const field = row.state === "draft" ? { ...originalField, required: false } : originalField;
          const entries = item.parentId ? row.values[item.parentId] || [] : [row.values];

          return entries.some((entry: any) => {
            let value = entry[field.id];
            if (field.type === "subform") {
              return field.required && (!Array.isArray(value) || !value.length);
            }
            try {
              if (isOrganizationField(field.type) && context) {
                const resolve = organizationDefaultResolver(
                  modelFormSchema(model),
                  context.organization,
                  context.actorId,
                  row.values,
                );
                if (value === undefined) {
                  value = resolve(field, item.parentId ? entry : undefined);
                }
                const values = { ...row.values, ...entry };
                const dependency = runtime.get(field.organization.scope.fieldId);
                if (dependency && values[dependency.id] === undefined) {
                  values[dependency.id] = resolve(dependency, item.parentId ? entry : undefined);
                }
                scalar(field, value);
                const allowed = new Set(
                  organizationCandidates(context.organization, context.actorId, field, values).map(
                    (candidate) => candidate.id,
                  ),
                );
                const selectedIds = Array.isArray(value) ? value : [value];
                return !emptyFieldValue(value) && selectedIds.some((id) => !allowed.has(id));
              }

              scalar(field, value === undefined ? fieldDefaultValue(field) : value);
              return false;
            } catch (error) {
              if (error instanceof BadRequestException) return true;
              throw error;
            }
          });
        });

        if (invalid) {
          records.find((item) => item.version === row.definition_version)!.incompatible++;
        }
      }

      cursor = rows.at(-1)!.id;
    }
  }

  // 6. 统计各数据版本关联的流程任务数量并生成确认 Token
  const taskSql = `
    SELECT
      r.definition_version AS version,
      count(*) FILTER (WHERE t.status <> 'completed')::int AS active,
      count(*) FILTER (WHERE t.status = 'completed')::int AS completed
    FROM tasks t
    JOIN records r ON r.id = t.record_id
    WHERE r.definition_id = $1
    GROUP BY r.definition_version
    ORDER BY r.definition_version
  `;
  const { rows: tasks } = await tx.query(taskSql, [definition.id]);

  const impact: Omit<DataModelImpact, "token"> = {
    definitionId: definition.id,
    title: definition.title,
    revision: definition.revision,
    fromVersion: definition.latest_version,
    toVersion: definition.latest_version + 1,
    ...(checksOrganization
      ? {
          organizationCheck:
            "组织字段按当前检查人的身份、当前组织及记录中的部门条件核对；其他成员办理时会按其身份重新检查。",
        }
      : {}),
    titleChanged: !!previous && previous.title !== definition.title,
    defaultPageWillPublish,
    changes: {
      added: changes.added.map(summarize),
      removed: changes.removed.map(summarize),
      changed: changes.changed.map(summarize),
      renamed: changes.renamed.map(summarize),
    },
    references,
    records,
    tasks,
    blockers: references
      .filter((item) => item.effect === "blocks")
      .map((item) => `${item.title}：${item.detail}`),
  };

  const token = createHash("sha256")
    .update(fingerprint({ impact, model, stamps, managePage }))
    .digest("hex");

  return { ...impact, token };
}
