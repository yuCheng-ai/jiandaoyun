import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { isOrganizationField, emptyFieldValue, fieldDefaultValue, textFormats, type ServerOrganization, dataFields, dataModelChanges, modelFormSchema, type DataModel, type DataModelImpact, type ModelFieldChange, type ProcessTemplateSpec } from "@platform/contracts";
import type { Transaction } from "../../core/database/database";
import { pageBindings } from "./page-schema";
import { referencedRelationFields } from "../relations/relation-rules";
import { allFields, scalar } from "../../core/database/schema";
import { organizationCandidates, organizationDefaultResolver } from "../directory/organization-fields";

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const fingerprint = (value: unknown) => JSON.stringify(canonical(value));
const settingNames: Record<string, string> = { defaultValue: "默认值", defaultFormula: "默认值方式", expression: "公式", formulaRemark: "公式备注", dateDefault: "默认值来源", min: "最小值", max: "最大值", precision: "小数位", retainPrecision: "保留小数位数", numberGrouping: "显示千分符", limitRange: "限定数值范围", maxLength: "文本长度", unique: "唯一性", options: "选项", format: "格式", choiceSource: "选项来源", organization: "组织选择规则" };
const display = (value: unknown) => value === undefined || value === null || value === "" ? "未设置" : JSON.stringify(value);
const displaySetting = (key: string, value: unknown, field: ReturnType<typeof dataFields>[number]["field"], identityNames: Map<string, string>, fieldNames: Map<string, string>) => {
  if (key === "organization") {
    const config = value as any;
    if (!config) return "未设置";
    const range = ({ all: "全部", custom: "指定范围", currentDepartment: "当前成员所在部门", fieldDepartment: "由部门字段决定" } as Record<string, string>)[config.scope.mode];
    const initial = ({ none: config.defaultIds.length ? "指定身份" : "无", currentUser: "当前成员", currentDepartment: "当前成员主部门", departmentManager: "主部门负责人" } as Record<string, string>)[config.defaultMode];
    const specified = [...config.scope.departmentIds, ...config.scope.employeeIds, ...config.scope.roleIds].map(id => identityNames.get(id) || "已不可用身份").join("、");
    const defaults = config.defaultIds.map((id: string) => identityNames.get(id) || "已不可用身份").join("、");
    return `${range}${config.scope.mode === "custom" ? `（${specified || "空范围"}）` : config.scope.mode === "fieldDepartment" ? `（${fieldNames.get(config.scope.fieldId) || "未选择"}）` : ""}，${config.scope.includeChildren ? "含下级部门" : "不含下级部门"}，默认${initial}${config.defaultMode === "none" && defaults ? `（${defaults}）` : ""}`;
  }
  if (key === "options") return field.settings.options?.map(option => option.label).join("、") || "无选项";
  if (key === "defaultValue" && ["choice", "choices"].includes(field.kind)) {
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    return selected.map(id => field.settings.options.find(option => option.id === id)?.label || "已失效选项").join("、") || "未设置";
  }
  if (key === "format") return ({ none: "普通文本", number: "数值", percent: "百分比", email: "邮箱", month: "年-月", date: "年-月-日", "datetime-local": "年-月-日 时:分", "datetime-second": "年-月-日 时:分:秒" } as Record<string, string>)[String(value)] || textFormats.find(item => item.value === value)?.label || display(value);
  if (key === "defaultFormula") return value ? "公式编辑" : "自定义";
  if (key === "expression" && typeof value === "string") return value.replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (_, id) => fieldNames.get(id) || "已失效字段");
  if (key === "dateDefault") return value === "now" ? "填写当时" : "自定义";
  if (["retainPrecision", "numberGrouping", "limitRange"].includes(key)) return value === undefined ? "原设置" : value ? "开启" : "关闭";
  if (key === "choiceSource" && field.settings.choiceSource?.mode === "manual") return "自定义选项";
  return display(value);
};

/** The preview returns configuration and aggregate counts, never record values or record IDs. */
export async function dataModelImpact(tx: Transaction, definition: any, model: DataModel, managePage = false, context?: { organization: ServerOrganization; actorId: string; publishingPageId?: string }): Promise<DataModelImpact> {
  const previous = (await tx.query("SELECT v.title,m.model FROM data_object_versions m JOIN definition_versions v USING(definition_id,version) WHERE m.definition_id=$1 AND m.version=$2", [definition.id, definition.latest_version])).rows[0];
  const before: DataModel = previous?.model || { version: 1, fields: [] };
  const changes = dataModelChanges(before, model), old = new Map(dataFields(before).map(item => [item.field.id, item]));
  const nextIds = new Set(dataFields(model).map(item => item.field.id));
  const names = new Map([...dataFields(before), ...dataFields(model)].map(item => [item.field.id, item.parentId ? `${[...model.fields, ...before.fields].find(f => f.id === item.parentId)!.name} / ${item.field.name}` : item.field.name]));
  const identityNames = new Map([...(context?.organization.users || []), ...(context?.organization.spec.departments || []), ...(context?.organization.spec.roles || [])].map(item => [item.id, item.name]));
  const summarize = (item: ReturnType<typeof dataFields>[number]): ModelFieldChange => {
    const prior = old.get(item.field.id), details: string[] = [];
    if (prior) {
      if (prior.field.required !== item.field.required) details.push(`永久必填：${prior.field.required ? "是" : "否"} → ${item.field.required ? "是" : "否"}`);
      for (const key of new Set([...Object.keys(prior.field.settings), ...Object.keys(item.field.settings)])) {
        const a = (prior.field.settings as any)[key], b = (item.field.settings as any)[key];
        if (fingerprint(a) !== fingerprint(b)) details.push(`${settingNames[key] || key}：${displaySetting(key, a, prior.field, identityNames, names)} → ${displaySetting(key, b, item.field, identityNames, names)}`);
      }
    } else if (item.field.required) details.push("新增永久必填字段");
    return { id: item.field.id, name: item.field.name, ...(item.parentId ? { parentName: [...model.fields, ...before.fields].find(f => f.id === item.parentId)!.name } : {}), ...(prior && prior.field.name !== item.field.name ? { beforeName: prior.field.name } : {}), details };
  };
  const affected = new Set([...changes.removed, ...changes.changed, ...changes.renamed].map(item => item.field.id));
  const references: DataModelImpact["references"] = [], stamps: unknown[] = [];
  let defaultPageWillPublish = false;
  const referenced = (ids: Iterable<string>) => [...ids].filter(id => affected.has(id)).map(id => names.get(id) || id);
  const missing = (ids: Iterable<string>) => [...ids].filter(id => !nextIds.has(id));
  for (const row of (await tx.query(`SELECT p.*,v.title AS public_title,v.schema,v.definition_version AS public_data_version FROM pages p
    LEFT JOIN page_versions v ON v.page_id=p.id AND v.version=p.latest_version WHERE p.definition_id=$1 ORDER BY p.id`, [definition.id])).rows) {
    stamps.push(["page", row.id, row.revision]);
    // This form and its fields commit together; its previous version stays immutable.
    if (row.id === context?.publishingPageId) continue;
    if (managePage && row.managed && !row.archived_at) defaultPageWillPublish = true;
    if (row.latest_version) {
      const ids = pageBindings(row.schema), blocked = !row.archived_at && missing(ids).length > 0 && !(managePage && row.managed);
      references.push({ kind: "page", id: row.id, title: row.public_title, state: "published", version: row.latest_version, fields: referenced(ids), effect: blocked ? "blocks" : "retained", detail: row.archived_at ? `页面已归档，保留数据 V${row.public_data_version} 的历史绑定；恢复前检查字段差异` : blocked ? `仍使用待移除字段：${missing(ids).map(id => names.get(id) || id).join("、")}；请先调整并发布页面` : managePage && row.managed ? "默认页面随此兼容定义一起发布；历史页面保留" : `保持数据 V${row.public_data_version}；采用新版需要重新编辑并发布` });
    }
    if (!row.latest_version || row.title !== row.public_title || row.definition_version !== row.public_data_version || fingerprint(row.draft) !== fingerprint(row.schema) || row.additions.length) {
      const ids = pageBindings(row.draft);
      references.push({ kind: "page", id: row.id, title: row.title, state: "draft", version: row.latest_version, fields: referenced(ids), effect: "review", detail: row.additions.length ? `含 ${row.additions.length} 项待发布字段变更；模型发布后需重新核对数据基线` : "页面草稿保留原版本；采用新版时需处理字段差异" });
    }
  }
  for (const row of (await tx.query(`SELECT d.*,v.spec FROM relation_definitions d LEFT JOIN relation_versions v ON v.relation_id=d.id AND v.version=d.latest_version
    WHERE d.source_definition_id=$1 OR d.target_definition_id=$1 ORDER BY d.id`, [definition.id])).rows) {
    stamps.push(["relation", row.id, row.revision]);
    const add = (spec: any, state: "draft" | "published") => {
      const ids = referencedRelationFields(spec, definition.id), blocked = state === "published" && missing(ids).length > 0;
      references.push({ kind: "relation", id: row.id, title: spec.title, state, version: row.latest_version, fields: referenced(ids), effect: blocked ? "blocks" : "review", detail: blocked ? `仍引用待移除字段：${missing(ids).map(id => names.get(id) || id).join("、")}；请先调整并发布关系` : "关系读取两端的已发布字段；检查筛选、展示和回填是否符合新规则" });
    };
    if (row.spec) add(row.spec, "published");
    if (!row.spec || fingerprint(row.spec) !== fingerprint(row.draft)) add(row.draft, "draft");
  }
  for (const row of (await tx.query(`SELECT t.*,v.spec FROM process_templates t LEFT JOIN process_template_versions v ON v.template_id=t.id AND v.version=t.latest_version
    WHERE t.workspace_id=$1 ORDER BY t.id`, [definition.workspace_id])).rows) {
    const add = (spec: ProcessTemplateSpec, state: "draft" | "published") => {
      const bindings = spec.bindings.filter(binding => binding.definitionId === definition.id);
      if (!bindings.length) return;
      stamps.push(["process", row.id, row.revision, state]);
      const bindingIds = new Set(bindings.map(b => b.id)), ids = new Set<string>();
      for (const task of spec.tasks) {
        if (bindingIds.has(task.recordBinding)) { task.requiredFields.forEach(id => ids.add(id)); if (task.subformId) ids.add(task.subformId); }
        if (task.waitFor && bindingIds.has(task.waitFor.recordBinding)) { ids.add(task.waitFor.fieldId); if (task.waitFor.subformId) ids.add(task.waitFor.subformId); }
      }
      references.push({ kind: "process", id: row.id, title: spec.title, state, version: row.latest_version, fields: referenced(ids), effect: "retained", detail: `${bindings.map(b => `${b.title}：数据 V${b.definitionVersion}`).join("；")}。任务范围、必填和等待条件继续按绑定版本执行` });
    };
    if (row.spec) add(row.spec, "published");
    if (!row.spec || fingerprint(row.spec) !== fingerprint(row.draft)) add(row.draft, "draft");
  }
  const organization = (await tx.query("SELECT revision,spec FROM workspace_organizations WHERE workspace_id=$1", [definition.workspace_id])).rows[0];
  stamps.push(["organization", organization?.revision]);
  const grantRows = (await tx.query(`SELECT g.user_id::text AS id,u.name AS title,g.policy,'成员' AS kind FROM grants g JOIN users u ON u.id=g.user_id WHERE g.definition_id=$1
    UNION ALL SELECT subject_id::text,subject_id::text,policy,subject_kind FROM subject_grants WHERE definition_id=$1 ORDER BY kind,id`, [definition.id])).rows;
  for (const row of grantRows) {
    stamps.push(["grant", row.kind, row.id, row.policy]);
    const title = row.kind === "department" ? `部门 · ${organization?.spec.departments.find((item: any) => item.id === row.id)?.name || "已停用部门"}` : row.kind === "role" ? `角色 · ${organization?.spec.roles.find((item: any) => item.id === row.id)?.name || "已停用角色"}` : `成员 · ${row.title}`;
    references.push({ kind: "permission", id: `${row.kind}:${row.id}`, title, state: "published", version: 0, fields: referenced(Object.keys(row.policy.fields)), effect: "retained", detail: "授权按字段身份保留，仍适用于历史版本；新增字段默认无权，需要另行授权" });
  }
  const groupRow = (await tx.query('SELECT config,revision FROM record_permission_groups WHERE definition_id=$1', [definition.id])).rows[0];
  if (groupRow) {
    stamps.push(['permission-groups', groupRow.revision]);
    for (const group of groupRow.config.groups) {
      const filters = group.filters.map((filter: {sourceFieldId: string}) => filter.sourceFieldId);
      const active = groupRow.config.mode === 'groups' && group.enabled && !group.archived;
      const blocked = active && group.actions.includes('view') && group.scope === 'custom' && missing(filters).length > 0;
      references.push({ kind: 'permission', id: `group:${group.id}`, title: `权限组 · ${group.name}`, state: 'published', version: groupRow.revision, fields: referenced([...Object.keys(group.fields), ...filters]), effect: blocked ? 'blocks' : 'retained', detail: blocked ? '使用中的自定义记录范围引用了待移除字段，请先调整权限组条件' : '字段授权及范围条件按稳定身份保留；新增字段默认隐藏，历史版本继续单独计算权限' });
    }
  }
  const records: DataModelImpact["records"] = (await tx.query(`SELECT definition_version AS version,count(*) FILTER(WHERE archived_at IS NULL)::int AS count,
    count(*) FILTER(WHERE archived_at IS NOT NULL)::int AS archived FROM records WHERE definition_id=$1 GROUP BY definition_version ORDER BY definition_version`, [definition.id])).rows.map(row => ({ ...row, incompatible: 0 }));
  const runtime = new Map(allFields(modelFormSchema(model)).map(field => [field.id, field]));
  const toCheck = [...changes.added, ...changes.changed];
  const checksOrganization = toCheck.some(item => isOrganizationField(item.field.kind));
  if (checksOrganization && context) stamps.push(["identities", context.organization.users.map(user => [user.id, user.name, user.active])]);
  // Bound memory for large objects. Only aggregate validation results leave this function.
  if (toCheck.length) {
    let cursor: string | null = null;
    for (;;) {
      const rows: any[] = (await tx.query("SELECT id,definition_version,values,state FROM records WHERE definition_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 500", [definition.id, cursor])).rows;
      if (!rows.length) break;
      for (const row of rows) {
        const invalid = toCheck.some(item => {
          const originalField = runtime.get(item.field.id)!;
          const field = row.state === "draft" ? { ...originalField, required: false } : originalField;
          const entries = item.parentId ? row.values[item.parentId] || [] : [row.values];
          return entries.some((entry: any) => {
            let value = entry[field.id];
            if (field.type === "subform") return field.required && (!Array.isArray(value) || !value.length);
            try {
              if (isOrganizationField(field.type) && context) {
                const resolve = organizationDefaultResolver(modelFormSchema(model), context.organization, context.actorId, row.values);
                if (value === undefined) value = resolve(field, item.parentId ? entry : undefined);
                const values = { ...row.values, ...entry }, dependency = runtime.get(field.organization.scope.fieldId);
                if (dependency && values[dependency.id] === undefined) values[dependency.id] = resolve(dependency, item.parentId ? entry : undefined);
                scalar(field, value);
                const allowed = new Set(organizationCandidates(context.organization, context.actorId, field, values).map(item => item.id));
                return !emptyFieldValue(value) && (Array.isArray(value) ? value : [value]).some(id => !allowed.has(id));
              }
              scalar(field, value === undefined ? fieldDefaultValue(field) : value); return false;
            } catch (error) { if (error instanceof BadRequestException) return true; throw error; }
          });
        });
        if (invalid) records.find(item => item.version === row.definition_version)!.incompatible++;
      }
      cursor = rows.at(-1)!.id;
    }
  }
  const tasks = (await tx.query(`SELECT r.definition_version AS version,count(*) FILTER(WHERE t.status<>'completed')::int AS active,count(*) FILTER(WHERE t.status='completed')::int AS completed
    FROM tasks t JOIN records r ON r.id=t.record_id WHERE r.definition_id=$1 GROUP BY r.definition_version ORDER BY r.definition_version`, [definition.id])).rows;
  const impact: Omit<DataModelImpact, "token"> = { definitionId: definition.id, title: definition.title, revision: definition.revision, fromVersion: definition.latest_version, toVersion: definition.latest_version + 1,
    ...(checksOrganization ? { organizationCheck: "组织字段按当前检查人的身份、当前组织及记录中的部门条件核对；其他成员办理时会按其身份重新检查。" } : {}),
    titleChanged: !!previous && previous.title !== definition.title, defaultPageWillPublish,
    changes: { added: changes.added.map(summarize), removed: changes.removed.map(summarize), changed: changes.changed.map(summarize), renamed: changes.renamed.map(summarize) },
    references, records, tasks, blockers: references.filter(item => item.effect === "blocks").map(item => `${item.title}：${item.detail}`) };
  return { ...impact, token: createHash("sha256").update(fingerprint({ impact, model, stamps, managePage })).digest("hex") };
}
