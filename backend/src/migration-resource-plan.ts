import { visibilityConditions, type VisibilityRule } from "@platform/contracts";
import { parseFieldTrash } from "./field-recycle";
import { validateRecordView } from "@platform/contracts";
import { createHash } from "node:crypto";
import { maxSubformRows } from "@platform/contracts";
import { BadRequestException } from "@nestjs/common";
import { isOrganizationField, isMultipleOrganization, separateFormSchema, modelFormSchema, type FormField, type FormSchema, type MigrationIdentityChoice, type MigrationIdentityReview, type MigrationResourcePlan, type MigrationResourceSource } from "@platform/contracts";
import { object, scalar, title } from "./schema";
import { parseModel, parsePage } from "./page-schema";
import { legacyRecordLifecycle } from "./legacy-record";
import { migrateAccess } from "./migration-access";
import { parseCollectionRules } from "./collection";
import type { MigrationRoleReview } from './migration-role-access';

export const canonicalMigration = (value: any): any => Array.isArray(value) ? value.map(canonicalMigration) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalMigration(value[key])])) : value;
export const migrationDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonicalMigration(value))).digest("hex");
const id = (value: unknown): string => { if (typeof value !== "string" || !value || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new BadRequestException("来源资源标识不合法"); return value; };
export function resourceSource(raw: unknown): MigrationResourceSource {
  object(raw); object(raw.application); object(raw.access); object(raw.recordViews);
  const allowed = ["format", "namespace", "applicationId", "fingerprint", "application", "forms", "entries", "access", "recordViews", "roles", "orders", "runs"];
  if (raw.format !== 1 || Object.keys(raw).some(key => !allowed.includes(key))) throw new BadRequestException("迁移资源包格式不支持，请保留原内容");
  id(raw.applicationId);
  if (raw.application.id !== raw.applicationId) throw new BadRequestException("来源应用身份不一致");
  for (const key of ["forms", "entries", "roles", "orders", "runs"]) {
    if (!Array.isArray(raw[key]) || raw[key].length > (key === "forms" ? 500 : 10000)) throw new BadRequestException("资源列表不合法或单次资源包超过检查容量，本次未写入，原内容保留");
    raw[key].forEach(object);
  }
  const forms = new Set<string>();
  for (const form of raw.forms) {
    id(form.id); if (form.appId !== raw.applicationId) throw new BadRequestException("资源包包含其他应用表单");
    if (forms.has(form.id)) throw new BadRequestException("来源表单身份重复"); forms.add(form.id);
    if (!Array.isArray(form.versions) || form.versions.length > 1000) throw new BadRequestException("历史版本列表无效或超过检查容量");
  }
  for (const entry of raw.entries) { id(entry.id); if (!forms.has(entry.formId)) throw new BadRequestException("记录不属于本次应用表单"); }
  for (const key of ["access", "recordViews"]) if (Object.keys(raw[key]).some(key => !forms.has(key))) throw new BadRequestException("配置引用了资源包外的表单");
  for (const key of ["orders", "runs"]) if (raw[key].some((item: any) => !forms.has(item.formId))) throw new BadRequestException("运行资源不属于本次应用表单");
  if (Buffer.byteLength(JSON.stringify(raw)) > 15 * 1024 * 1024) throw new BadRequestException("单次资源包超过 15 MB，本次未写入，原内容保留");
  return structuredClone(raw) as MigrationResourceSource;
}
type Reserve = (kind: "application" | "data_object" | "page" | "record" | "row", parts: unknown[]) => Promise<string>;
/** Exact-version projection. Raw payload remains immutable alongside this result. */
export async function planMigrationResources(source: MigrationResourceSource, choices: MigrationIdentityChoice[], identityReview: MigrationIdentityReview, reserve: Reserve, roleReview?: MigrationRoleReview) {
  const issues: MigrationResourcePlan["issues"] = [], forms: MigrationResourcePlan["forms"] = [], records: MigrationResourcePlan["records"] = [];
  const projection: { forms: any[]; records: any[] } = { forms: [], records: [] };
  const access: NonNullable<MigrationResourcePlan["access"]> = [];
  const issue = (formId: string, version: string, kind: "invalid" | "mapping" | "unsupported", message: string, extra: Partial<MigrationResourcePlan["issues"][number]> = {}) => issues.push({ formId, version, kind, message, ...extra });
  const validTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  try { title(source.application.name); } catch { issue("", "应用设置", "invalid", "应用名称无效。"); }
  if (Object.keys(source.application).some(key => !["id", "name", "color", "icon", "folders", "description"].includes(key))) issue("", "应用设置", "unsupported", "应用包含尚未接通的设置，不能忽略后导入。");
  if (source.application.folders !== undefined && (!Array.isArray(source.application.folders) || source.application.folders.some(folder => typeof folder !== "string" || !folder.trim()))) issue("", "应用设置", "invalid", "应用文件夹列表无效。");
  for (const key of ["color", "icon", "description"]) if (source.application[key] !== undefined && typeof source.application[key] !== "string") issue("", "应用设置", "invalid", "应用显示设置格式无效。");
  for (const blocker of identityReview.blockers) issue("", "身份对应", "mapping", blocker);
  if (!identityReview.confirmationCurrent) issue("", "身份对应", "mapping", "身份对应尚未确认或确认依据已变化，执行导入前需要重新核对。");
  const mapped = (kind: MigrationIdentityChoice["kind"], value: unknown): string => {
    if (typeof value !== "string") throw new Error("组织引用不是有效身份标识");
    const choice = choices.find(item => item.kind === kind && item.sourceId === value);
    if (!choice?.targetId || choice.mode === "unresolved") throw new Error("组织引用尚未建立明确身份对应");
    return choice.targetId;
  };
  const organizationValue = (field: FormField, value: unknown) => {
    if (value === undefined || value === null || value === "" || !isOrganizationField(field.type)) return value;
    const kind = field.type.startsWith("department") ? "department" : "member";
    if (isMultipleOrganization(field.type)) { if (!Array.isArray(value)) throw new Error("组织多选值不是身份列表"); return value.map(item => mapped(kind, item)); }
    return mapped(kind, value);
  };
  const mapVisibility = (rules: VisibilityRule[], fields: FormField[]) => {
    const result = structuredClone(rules);
    const all = fields.flatMap(field => [field, ...field.children]);
    for (const condition of result.flatMap(visibilityConditions)) {
      const field = all.find(field => field.id === condition.sourceId);
      if (!field || !isOrganizationField(field.type) || condition.operator === 'empty' || !condition.value) continue;
      if (!['equals', 'notEquals', 'contains'].includes(condition.operator)) throw Error('组织字段显隐条件不能按数值比较');
      condition.value = mapped(field.type.startsWith('department') ? 'department' : 'member', condition.value);
    }
    return result;
  };
  const mapFieldOrganization = (field: FormField) => {
    if (!isOrganizationField(field.type)) return;
    object(field.organization); object(field.organization.scope);
    const config = field.organization, scope = config.scope;
    for (const [key, kind] of [["employeeIds", "member"], ["departmentIds", "department"], ["roleIds", "role"]] as const) {
      if (!Array.isArray(scope[key])) throw new Error("组织范围格式不合法");
      scope[key] = scope[key].map(value => mapped(kind, value));
    }
    if (!Array.isArray(config.defaultIds)) throw new Error("默认组织身份格式不合法");
    config.defaultIds = config.defaultIds.map(value => mapped(field.type.startsWith("department") ? "department" : "member", value));
    field.defaultValue = organizationValue(field, field.defaultValue) as FormField["defaultValue"];
  };
  const schemaProjection = (formId: string, version: string, raw: any, draft: boolean) => {
    try {
      object(raw); if (!Array.isArray(raw.fields)) throw new Error("字段列表缺失");
      const schema = structuredClone(raw) as FormSchema; let fieldCount = 0;
      const visit = (field: FormField, depth = 0) => {
        object(field); if (++fieldCount > 1000 || depth > 10 || !Array.isArray(field.children)) throw new Error("字段结构过深、过多或缺失子字段列表");
        mapFieldOrganization(field);
        field.children.forEach(child => visit(child, depth + 1));
      };
      schema.fields.forEach(field => visit(field));
      schema.settings.rules = mapVisibility(schema.settings.rules, schema.fields);
      const separated = separateFormSchema(schema), model = parseModel(separated.model, draft), page = parsePage(separated.page, model, draft);
      return { model, page, runtime: modelFormSchema(model) };
    } catch (cause) { issue(formId, version, "unsupported", `字段转换未通过：${(cause as Error).message}`); return undefined; }
  };
  const sourceVersions = new Map<string, Map<number, any[]>>(), projectedVersions = new Map<string, ReturnType<typeof schemaProjection>>();
  let historyEvents = 0;
  const targetApplicationId = await reserve("application", [source.applicationId]);
  for (const form of source.forms as any[]) {
    try { title(form.title); } catch { issue(form.id, "草稿", "invalid", "表单名称无效。"); }
    if (!validTime(form.createdAt) || !validTime(form.updatedAt) || typeof form.archived !== "boolean" || typeof form.folder !== "string") issue(form.id, "草稿", "invalid", "表单创建时间、分组或归档状态缺失，不能自动补写。");
    if (form.kind !== "form") issue(form.id, "表单类型", "unsupported", "此表单类型的流程执行尚未接通服务端，保留原表单。");
    const definitionId = await reserve("data_object", [form.id]), pageId = await reserve("page", [form.id]);
    const catalog = new Map<number, any[]>(); sourceVersions.set(form.id, catalog);
    for (const original of [...form.versions, ...(form.published ? [form.published] : [])]) {
      if (!original || !Number.isSafeInteger(original.version) || original.version < 1) { issue(form.id, "历史版本", "invalid", "发布版本编号不合法，无法建立记录对应。"); continue; }
      const variants = catalog.get(original.version) || [];
      if (!variants.some(value => migrationDigest(value) === migrationDigest(original))) variants.push(original);
      catalog.set(original.version, variants);
    }
    const draft = schemaProjection(form.id, "草稿", form.schema, true), versionPlans: MigrationResourcePlan["forms"][number]["versions"] = [], converted: any[] = [];
    if (!form.published && catalog.size || form.published && form.published.version !== Math.max(...catalog.keys())) issue(form.id, "发布状态", "unsupported", "当前发布版本与历史版本顺序不一致，不能自动选择另一个版本。");
    let fieldTrash;
    try {
      const activeIds = form.schema.fields.flatMap((field: FormField) => [field.id, ...field.children.map(child => child.id)]);
      fieldTrash = parseFieldTrash(form.fieldTrash ?? [], activeIds).map(item => {
        [item.field, ...item.field.children].forEach(mapFieldOrganization);
        return { ...item, rules: mapVisibility(item.rules, [...form.schema.fields, ...(form.fieldTrash || []).map((entry: any) => entry.field)]) };
      });
      // Recycle fields retain references to absent fields; validate with their own contract.
      fieldTrash = parseFieldTrash(fieldTrash, activeIds);
    } catch (cause) { issue(form.id, '字段回收站', 'unsupported', (cause as Error).message); }
    const contexts = [{ label: "草稿", value: form }, ...[...catalog].flatMap(([version, variants]) => variants.map(value => ({ label: `V${version}`, value })))];
    for (const context of contexts) {
      if (context.value.workflow?.nodes?.length || context.value.workflow?.enabled) issue(form.id, context.label, "unsupported", "原流程画布和运行语义保留在快照中，尚未转换为服务端流程。");
      if (Object.entries(context.value.extensions || {}).some(([, value]) => value !== undefined && (!Array.isArray(value) || value.length))) issue(form.id, context.label, "unsupported", "扩展配置与停用状态保留，执行适配尚未完成。");
    }
    for (const [version, variants] of [...catalog].sort(([a], [b]) => a - b)) {
      if (variants.length > 1) issue(form.id, `V${version}`, "invalid", "同一发布版本存在不同内容，不能为旧记录任选一个版本。");
      const result = variants.length === 1 ? schemaProjection(form.id, `V${version}`, variants[0].schema, false) : undefined;
      if (variants.length === 1) {
        try { title(variants[0].title); } catch { issue(form.id, `V${version}`, "invalid", "历史表单名称无效。"); }
        if (!validTime(variants[0].publishedAt)) issue(form.id, `V${version}`, "invalid", "历史发布时间无效，不能替换成导入时间。");
      }
      projectedVersions.set(JSON.stringify([form.id, version]), result);
      versionPlans.push({ sourceVersion: version, targetVersion: version, variants: variants.length, checked: !!result });
      if (result) converted.push({ version, title: variants[0].title, publishedAt: variants[0].publishedAt, model: result.model, page: result.page });
    }
    let accessConfig;
    {
      const before = issues.length;
      const result = migrateAccess(form.id, source.access[form.id] ?? {}, contexts.map(context => context.value.schema), choices,
        (kind, message, groupId, fieldId) => issue(form.id, "访问权限", kind, message, { ...(groupId ? { groupId } : {}), ...(fieldId ? { fieldId } : {}) }));
      access.push(result.summary); accessConfig = result.config;
      if (accessConfig?.publicEnabled) issue(form.id, "访问权限", "unsupported", "公开填写尚未接通服务端，不能在导入时关闭原入口或改成成员入口。");
      if (accessConfig?.groups.some(group => group.subjects.some(subject => subject.historical))) issue(form.id, "访问权限", "mapping", "权限组引用了独立历史身份，需要明确的当前组织对应，不能为历史档案启用授权。");
      if (!form.published && accessConfig?.groups.length) issue(form.id, "访问权限", "unsupported", "尚未发布表单的预设权限组需先接通，不能丢弃后导入。");
      if (accessConfig) {
        const publishedFields = new Set(converted.flatMap(version => version.model.fields.flatMap((field: any) => [field.id, ...field.children.map((child: any) => child.id)])));
        if (accessConfig.groups.some(group => Object.keys(group.fields).some(id => !publishedFields.has(id)))) issue(form.id, "访问权限", "unsupported", "权限组仍引用未发布字段，需保留原配置，不能忽略该字段授权。");
      }
      if (accessConfig) try { parseCollectionRules(accessConfig.filling); } catch (cause) { issue(form.id, "收集规则", "invalid", (cause as Error).message); }
      result.summary.executionReady = !!accessConfig && issues.length === before;
    }
    let recordView;
    if (source.recordViews[form.id] !== undefined) try {
      const fieldIds=new Set<string>([...(draft?.model.fields || []),...converted.flatMap(version=>version.model.fields)].map(field=>field.id));
      recordView=validateRecordView(source.recordViews[form.id],fieldIds);
    } catch (cause) { issue(form.id,"列表设置","invalid",(cause as Error).message); }
    forms.push({ sourceId: form.id, title: String(form.title || form.id), archived: !!form.archived, definitionId, pageId, versions: versionPlans, draftChecked: !!draft });
    projection.forms.push({ ...(fieldTrash ? { fieldTrash } : {}), ...(recordView ? { recordView } : {}), sourceId: form.id, definitionId, pageId, publishedVersion: form.published?.version ?? null, ...(draft ? { draft: { model: draft.model, page: draft.page } } : {}), ...(accessConfig ? { access: accessConfig } : {}), versions: converted });
  }
  const duplicateRecords = new Set(source.entries.filter((entry, index, all) => all.findIndex(other => other.id === entry.id) !== index).map(entry => entry.id));
  for (const entry of source.entries as any[]) {
    const start = issues.length, version = `V${entry.definitionVersion}`, targetId = await reserve("record", [entry.formId, entry.id]);
    const rows: MigrationResourcePlan["records"][number]["rows"] = [];
    const report = (kind: "invalid" | "mapping" | "unsupported", message: string, extra: Partial<MigrationResourcePlan["issues"][number]> = {}) => issue(entry.formId, version, kind, message, { recordId: entry.id, ...extra });
    if (duplicateRecords.has(entry.id)) report("invalid", "记录身份重复，不能创建副本绕过冲突。");
    const variants = sourceVersions.get(entry.formId)?.get(entry.definitionVersion);
    if (!variants) report("invalid", "记录引用的发布版本不存在，不能用当前草稿替代。");
    else if (variants.length !== 1) report("invalid", "记录引用的发布版本有冲突，需先核对原发布内容。");
    const validated = projectedVersions.get(JSON.stringify([entry.formId, entry.definitionVersion]));
    if (!validated && variants?.length === 1) report("unsupported", "此记录对应的历史字段定义尚未通过转换。");
    // Use the first archived definition only for inventory, never value conversion when variants conflict.
    const originalSchema = variants?.[0]?.schema;
    const rawFields: any[] = Array.isArray(originalSchema?.fields) ? originalSchema.fields : [];
    const flatten = (fields: any[], depth = 0): any[] => depth > 10 ? [] : fields.filter(field => field && typeof field === "object").flatMap(field => field.type === "tabs" ? flatten(Array.isArray(field.children) ? field.children : [], depth + 1) : [field]);
    let values: Record<string, any> = {}, creatorId: string | undefined, departmentIds: string[] | undefined;
    try { object(entry.values); } catch { report("invalid", "记录值不是字段对象。"); }
    const input = entry.values && typeof entry.values === "object" && !Array.isArray(entry.values) ? entry.values : {};
    for (const field of flatten(rawFields).filter(field => field.type === "subform")) {
      const rawRows = input[field.id]; if (rawRows === undefined) continue;
      if (!Array.isArray(rawRows)) { report("invalid", "明细值不是行列表。", { fieldId: field.id }); continue; }
      if (rawRows.length > maxSubformRows) report("unsupported", `明细超过当前服务端每条记录 ${maxSubformRows} 行的容量。`, { fieldId: field.id });
      const rowSet = new Set<string>(), digest = migrationDigest(rawRows);
      for (const [index, rawRow] of rawRows.entries()) {
        const originalRowId = rawRow && typeof rawRow === "object" && typeof rawRow._rowId === "string" && rawRow._rowId ? rawRow._rowId : undefined;
        if (rawRow && Object.hasOwn(rawRow, "_rowId") && !originalRowId) report("invalid", "原明细行身份格式无效，不能静默替换。", { fieldId: field.id, rowIndex: index });
        if (originalRowId && rowSet.has(originalRowId)) report("invalid", "同一明细存在重复的原行身份。", { fieldId: field.id, rowIndex: index });
        if (originalRowId) rowSet.add(originalRowId);
        const target = await reserve("row", [entry.formId, entry.id, field.id, ...(originalRowId ? ["id", originalRowId] : ["snapshot", digest, index])]);
        rows.push({ fieldId: field.id, ...(originalRowId ? { sourceRowId: originalRowId } : {}), index, targetId: target });
      }
    }
    if (validated) {
      const required = entry.status !== "draft";
      const convert = (field: FormField, value: unknown) => scalar(field, organizationValue(field, value), required);
      for (const key of Object.keys(input)) if (!validated.runtime.fields.some(field => field.id === key)) report("invalid", "记录包含该发布版本未定义的字段。", { fieldId: key });
      for (const field of validated.runtime.fields) {
        if (field.type !== "subform") {
          try { const value = convert(field, input[field.id]); if (Object.hasOwn(input, field.id)) values[field.id] = value; }
          catch (cause) { report("invalid", (cause as Error).message, { fieldId: field.id }); }
          continue;
        }
        if (!Object.hasOwn(input, field.id)) { if (required && field.required) report("invalid", "必填明细缺失。", { fieldId: field.id }); continue; }
        if (!Array.isArray(input[field.id])) continue;
        if (required && field.required && !input[field.id].length) report("invalid", "必填明细不能为空。", { fieldId: field.id });
        values[field.id] = input[field.id].map((row: any, index: number) => {
          const result: Record<string, any> = { _rowId: rows.find(item => item.fieldId === field.id && item.index === index)?.targetId };
          if (!row || typeof row !== "object" || Array.isArray(row)) { report("invalid", "明细行不是字段对象。", { fieldId: field.id, rowIndex: index }); return result; }
          for (const key of Object.keys(row)) if (key !== "_rowId" && !field.children.some(child => child.id === key)) report("invalid", "明细包含该发布版本未定义的列。", { fieldId: key, rowIndex: index });
          for (const child of field.children) {
            try { const value = convert(child, row[child.id]); if (Object.hasOwn(row, child.id)) result[child.id] = value; }
            catch (cause) { report("invalid", (cause as Error).message, { fieldId: child.id, rowIndex: index }); }
          }
          return result;
        });
      }
    }
    try { if (!entry.createdBy) throw new Error("历史创建者缺失，不能默认归给迁移操作者。"); creatorId = mapped("member", entry.createdBy); } catch (cause) { report("mapping", (cause as Error).message); }
    try { if (entry.createdDepartmentIds !== undefined) { if (!Array.isArray(entry.createdDepartmentIds)) throw new Error("历史创建部门不是列表。"); departmentIds = entry.createdDepartmentIds.map((value: unknown) => mapped("department", value)); } } catch (cause) { report("mapping", (cause as Error).message); }
    try { legacyRecordLifecycle(entry); } catch (cause) { report("invalid", (cause as Error).message); }
    if (Array.isArray(entry.history)) historyEvents += entry.history.length;
    if (entry.currentNodeId && variants?.length === 1 && (!Array.isArray(variants[0].workflow?.nodes) || !variants[0].workflow.nodes.some((node: any) => node?.id === entry.currentNodeId))) report("invalid", "当前处理节点不在记录引用的发布流程中。");
    const checked = issues.length === start;
    records.push({ sourceId: entry.id, formId: entry.formId, targetId, version: entry.definitionVersion, status: String(entry.status), deleted: !!entry.deletedAt, rows, checked });
    if (checked) projection.records.push({ sourceId: entry.id, targetId, definitionId: forms.find(form => form.sourceId === entry.formId)!.definitionId, version: entry.definitionVersion, values, creatorId, ...(departmentIds ? { createdDepartmentIds: departmentIds } : {}), createdAt: entry.createdAt, updatedAt: entry.updatedAt, deletedAt: entry.deletedAt, status: entry.status, history: entry.history, currentNodeId: entry.currentNodeId });
  }
  if (roleReview) issues.push(...roleReview.issues);
  else if (source.roles.length) issue("", "应用授权", "mapping", "请先核对来源角色与当前通讯录授权。");
  if (source.orders.length || source.runs.length) issue("", "运行资源", "unsupported", "支付订单与扩展运行轨迹已保留，执行适配尚未完成。");
  return { projection, plan: { ...(roleReview ? { roleAuthorization: { signature: roleReview.signature, roleCount: roleReview.roleCount } } : {}), targetApplicationId, forms, records, access, issues, totals: { forms: forms.length, versions: forms.reduce((sum, form) => sum + form.versions.length, 0), records: records.length, rows: records.reduce((sum, record) => sum + record.rows.length, 0), archivedForms: forms.filter(form => form.archived).length, deletedRecords: records.filter(record => record.deleted).length, draftRecords: records.filter(record => record.status === "draft").length, historyEvents, orders: source.orders.length, runs: source.runs.length } } };
}
