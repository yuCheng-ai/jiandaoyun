import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  isMultipleOrganization,
  isOrganizationField,
  maxSubformRows,
  modelFormSchema,
  separateFormSchema,
  validateRecordView,
  visibilityConditions,
  type FormField,
  type FormSchema,
  type MigrationIdentityChoice,
  type MigrationIdentityReview,
  type MigrationResourcePlan,
  type MigrationResourceSource,
  type VisibilityRule,
} from "@platform/contracts";
import { object, scalar, title } from "../../core/database/schema";
import { parseFieldTrash } from "../pages/field-recycle";
import { parseModel, parsePage } from "../pages/page-schema";
import { parseCollectionRules } from "../records/collection.service";
import { legacyRecordLifecycle } from "../records/legacy-record";
import { migrateAccess } from "./migration-access";
import type { MigrationRoleReview } from "./migration-role-access";

type Reserve = (
  kind: "application" | "data_object" | "page" | "record" | "row",
  parts: unknown[],
) => Promise<string>;

// ============================================================================
// 1. 标准化摘要计算与来源资源包格式校验
// ============================================================================

/** 递归按键名排序规范化任意 JSON 值，用于计算稳定摘要 */
export const canonicalMigration = (value: any): any => {
  if (Array.isArray(value)) {
    return value.map(canonicalMigration);
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, canonicalMigration(value[key])]);
    return Object.fromEntries(entries);
  }
  return value;
};

/** 计算任意数据结构的 SHA-256 标准化摘要 */
export const migrationDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalMigration(value)))
    .digest("hex");

/** 校验非空且不含控制字符的来源资源标识 */
function validateResourceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new BadRequestException("来源资源标识不合法");
  }
  return value;
}

/** 校验时间字符串是否为有效时间戳 */
function isValidTime(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** 展平标签页（tabs）容器内的字段列表（用于提取子表定义） */
function flattenNonTabFields(fields: any[], depth = 0): any[] {
  if (depth > 10) return [];
  return fields
    .filter((field) => field && typeof field === "object")
    .flatMap((field) => {
      if (field.type === "tabs") {
        const children = Array.isArray(field.children) ? field.children : [];
        return flattenNonTabFields(children, depth + 1);
      }
      return [field];
    });
}

/**
 * 解析并校验迁移资源包的顶层结构、容量限制与跨表引用完整性
 */
export function resourceSource(raw: unknown): MigrationResourceSource {
  object(raw);
  object(raw.application);
  object(raw.access);
  object(raw.recordViews);

  const allowedKeys = [
    "format",
    "namespace",
    "applicationId",
    "fingerprint",
    "application",
    "forms",
    "entries",
    "access",
    "recordViews",
    "roles",
    "orders",
    "runs",
  ];
  if (raw.format !== 1 || Object.keys(raw).some((key) => !allowedKeys.includes(key))) {
    throw new BadRequestException("迁移资源包格式不支持，请保留原内容");
  }

  validateResourceId(raw.applicationId);
  if (raw.application.id !== raw.applicationId) {
    throw new BadRequestException("来源应用身份不一致");
  }

  for (const key of ["forms", "entries", "roles", "orders", "runs"]) {
    const maxItems = key === "forms" ? 500 : 10000;
    if (!Array.isArray(raw[key]) || raw[key].length > maxItems) {
      throw new BadRequestException(
        "资源列表不合法或单次资源包超过检查容量，本次未写入，原内容保留",
      );
    }
    raw[key].forEach(object);
  }

  const forms = new Set<string>();
  for (const form of raw.forms) {
    validateResourceId(form.id);
    if (form.appId !== raw.applicationId) {
      throw new BadRequestException("资源包包含其他应用表单");
    }
    if (forms.has(form.id)) {
      throw new BadRequestException("来源表单身份重复");
    }
    forms.add(form.id);
    if (!Array.isArray(form.versions) || form.versions.length > 1000) {
      throw new BadRequestException("历史版本列表无效或超过检查容量");
    }
  }

  for (const entry of raw.entries) {
    validateResourceId(entry.id);
    if (!forms.has(entry.formId)) {
      throw new BadRequestException("记录不属于本次应用表单");
    }
  }

  for (const key of ["access", "recordViews"]) {
    if (Object.keys(raw[key]).some((formId) => !forms.has(formId))) {
      throw new BadRequestException("配置引用了资源包外的表单");
    }
  }

  for (const key of ["orders", "runs"]) {
    if (raw[key].some((item: any) => !forms.has(item.formId))) {
      throw new BadRequestException("运行资源不属于本次应用表单");
    }
  }

  if (Buffer.byteLength(JSON.stringify(raw)) > 15 * 1024 * 1024) {
    throw new BadRequestException("单次资源包超过 15 MB，本次未写入，原内容保留");
  }

  return structuredClone(raw) as MigrationResourceSource;
}

// ============================================================================
// 2. 资源转换计划与精确版本投影核心
// ============================================================================

/**
 * 演练并生成完整的迁移资源转换计划与目标数据结构投影（保持原始 payload 不可变）：
 * 涵盖应用设置、表单草稿与历史版本、回收站字段、访问权限、视图配置以及历史记录与子表行。
 */
export async function planMigrationResources(
  source: MigrationResourceSource,
  choices: MigrationIdentityChoice[],
  identityReview: MigrationIdentityReview,
  reserve: Reserve,
  roleReview?: MigrationRoleReview,
) {
  const issues: MigrationResourcePlan["issues"] = [];
  const forms: MigrationResourcePlan["forms"] = [];
  const records: MigrationResourcePlan["records"] = [];
  const projection: { forms: any[]; records: any[] } = { forms: [], records: [] };
  const access: NonNullable<MigrationResourcePlan["access"]> = [];

  const addIssue = (
    formId: string,
    version: string,
    kind: "invalid" | "mapping" | "unsupported",
    message: string,
    extra: Partial<MigrationResourcePlan["issues"][number]> = {},
  ) => {
    issues.push({ formId, version, kind, message, ...extra });
  };

  // 1. 校验应用基础设置与身份确认状态
  try {
    title(source.application.name);
  } catch {
    addIssue("", "应用设置", "invalid", "应用名称无效。");
  }

  const allowedAppKeys = ["id", "name", "color", "icon", "folders", "description"];
  if (Object.keys(source.application).some((key) => !allowedAppKeys.includes(key))) {
    addIssue("", "应用设置", "unsupported", "应用包含尚未接通的设置，不能忽略后导入。");
  }

  const hasInvalidFolders =
    source.application.folders !== undefined &&
    (!Array.isArray(source.application.folders) ||
      source.application.folders.some((folder) => typeof folder !== "string" || !folder.trim()));
  if (hasInvalidFolders) {
    addIssue("", "应用设置", "invalid", "应用文件夹列表无效。");
  }

  for (const key of ["color", "icon", "description"]) {
    if (source.application[key] !== undefined && typeof source.application[key] !== "string") {
      addIssue("", "应用设置", "invalid", "应用显示设置格式无效。");
    }
  }

  for (const blocker of identityReview.blockers) {
    addIssue("", "身份对应", "mapping", blocker);
  }
  if (!identityReview.confirmationCurrent) {
    addIssue(
      "",
      "身份对应",
      "mapping",
      "身份对应尚未确认或确认依据已变化，执行导入前需要重新核对。",
    );
  }

  // 2. 组织架构引用与显隐规则转换辅助函数
  const resolveMappedId = (kind: MigrationIdentityChoice["kind"], value: unknown): string => {
    if (typeof value !== "string") {
      throw new Error("组织引用不是有效身份标识");
    }
    const choice = choices.find((item) => item.kind === kind && item.sourceId === value);
    if (!choice?.targetId || choice.mode === "unresolved") {
      throw new Error("组织引用尚未建立明确身份对应");
    }
    return choice.targetId;
  };

  const mapOrganizationValue = (field: FormField, value: unknown) => {
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      !isOrganizationField(field.type)
    ) {
      return value;
    }
    const kind = field.type.startsWith("department") ? "department" : "member";
    if (isMultipleOrganization(field.type)) {
      if (!Array.isArray(value)) {
        throw new Error("组织多选值不是身份列表");
      }
      return value.map((item) => resolveMappedId(kind, item));
    }
    return resolveMappedId(kind, value);
  };

  const mapVisibilityRules = (rules: VisibilityRule[], fields: FormField[]) => {
    const result = structuredClone(rules);
    const allFields = fields.flatMap((field) => [field, ...field.children]);
    for (const condition of result.flatMap(visibilityConditions)) {
      const field = allFields.find((f) => f.id === condition.sourceId);
      if (
        !field ||
        !isOrganizationField(field.type) ||
        condition.operator === "empty" ||
        !condition.value
      ) {
        continue;
      }
      if (!["equals", "notEquals", "contains"].includes(condition.operator)) {
        throw Error("组织字段显隐条件不能按数值比较");
      }
      const kind = field.type.startsWith("department") ? "department" : "member";
      condition.value = resolveMappedId(kind, condition.value);
    }
    return result;
  };

  const mapFieldOrganizationConfig = (field: FormField) => {
    if (!isOrganizationField(field.type)) return;
    object(field.organization);
    object(field.organization.scope);

    const config = field.organization;
    const scope = config.scope;
    const scopeMappings = [
      ["employeeIds", "member"],
      ["departmentIds", "department"],
      ["roleIds", "role"],
    ] as const;

    for (const [key, kind] of scopeMappings) {
      if (!Array.isArray(scope[key])) {
        throw new Error("组织范围格式不合法");
      }
      scope[key] = scope[key].map((value) => resolveMappedId(kind, value));
    }

    if (!Array.isArray(config.defaultIds)) {
      throw new Error("默认组织身份格式不合法");
    }
    const defaultKind = field.type.startsWith("department") ? "department" : "member";
    config.defaultIds = config.defaultIds.map((value) => resolveMappedId(defaultKind, value));
    field.defaultValue = mapOrganizationValue(
      field,
      field.defaultValue,
    ) as FormField["defaultValue"];
  };

  const projectFormSchema = (formId: string, version: string, raw: any, draft: boolean) => {
    try {
      object(raw);
      if (!Array.isArray(raw.fields)) {
        throw new Error("字段列表缺失");
      }

      const schema = structuredClone(raw) as FormSchema;
      let fieldCount = 0;

      const visit = (field: FormField, depth = 0) => {
        object(field);
        if (++fieldCount > 1000 || depth > 10 || !Array.isArray(field.children)) {
          throw new Error("字段结构过深、过多或缺失子字段列表");
        }
        mapFieldOrganizationConfig(field);
        field.children.forEach((child) => visit(child, depth + 1));
      };

      schema.fields.forEach((field) => visit(field));
      schema.settings.rules = mapVisibilityRules(schema.settings.rules, schema.fields);

      const separated = separateFormSchema(schema);
      const model = parseModel(separated.model, draft);
      const page = parsePage(separated.page, model, draft);
      return { model, page, runtime: modelFormSchema(model) };
    } catch (cause) {
      addIssue(formId, version, "unsupported", `字段转换未通过：${(cause as Error).message}`);
      return undefined;
    }
  };

  // 3. 逐个校验并投影表单定义、历史发布版本、字段回收站、访问权限与视图设置
  const sourceVersions = new Map<string, Map<number, any[]>>();
  const projectedVersions = new Map<string, ReturnType<typeof projectFormSchema>>();
  let historyEvents = 0;
  const targetApplicationId = await reserve("application", [source.applicationId]);

  for (const form of source.forms as any[]) {
    try {
      title(form.title);
    } catch {
      addIssue(form.id, "草稿", "invalid", "表单名称无效。");
    }

    if (
      !isValidTime(form.createdAt) ||
      !isValidTime(form.updatedAt) ||
      typeof form.archived !== "boolean" ||
      typeof form.folder !== "string"
    ) {
      addIssue(
        form.id,
        "草稿",
        "invalid",
        "表单创建时间、分组或归档状态缺失，不能自动补写。",
      );
    }

    if (form.kind !== "form") {
      addIssue(
        form.id,
        "表单类型",
        "unsupported",
        "此表单类型的流程执行尚未接通服务端，保留原表单。",
      );
    }

    const definitionId = await reserve("data_object", [form.id]);
    const pageId = await reserve("page", [form.id]);
    const catalog = new Map<number, any[]>();
    sourceVersions.set(form.id, catalog);

    for (const original of [...form.versions, ...(form.published ? [form.published] : [])]) {
      if (!original || !Number.isSafeInteger(original.version) || original.version < 1) {
        addIssue(form.id, "历史版本", "invalid", "发布版本编号不合法，无法建立记录对应。");
        continue;
      }
      const variants = catalog.get(original.version) || [];
      if (!variants.some((value) => migrationDigest(value) === migrationDigest(original))) {
        variants.push(original);
      }
      catalog.set(original.version, variants);
    }

    const draft = projectFormSchema(form.id, "草稿", form.schema, true);
    const versionPlans: MigrationResourcePlan["forms"][number]["versions"] = [];
    const converted: any[] = [];

    const isPublishedOrderMismatch =
      (!form.published && catalog.size > 0) ||
      (form.published && form.published.version !== Math.max(...catalog.keys()));
    if (isPublishedOrderMismatch) {
      addIssue(
        form.id,
        "发布状态",
        "unsupported",
        "当前发布版本与历史版本顺序不一致，不能自动选择另一个版本。",
      );
    }

    // 转换字段回收站
    let fieldTrash;
    try {
      const activeIds = form.schema.fields.flatMap((field: FormField) => [
        field.id,
        ...field.children.map((child) => child.id),
      ]);
      const mappedTrash = parseFieldTrash(form.fieldTrash ?? [], activeIds).map((item) => {
        [item.field, ...item.field.children].forEach(mapFieldOrganizationConfig);
        const allReferenceFields = [
          ...form.schema.fields,
          ...(form.fieldTrash || []).map((entry: any) => entry.field),
        ];
        return {
          ...item,
          rules: mapVisibilityRules(item.rules, allReferenceFields),
        };
      });
      // 回收站字段可能保留对已删除字段的引用，使用其专属契约二次校验
      fieldTrash = parseFieldTrash(mappedTrash, activeIds);
    } catch (cause) {
      addIssue(form.id, "字段回收站", "unsupported", (cause as Error).message);
    }

    const contexts = [
      { label: "草稿", value: form },
      ...[...catalog].flatMap(([version, variants]) =>
        variants.map((value) => ({ label: `V${version}`, value })),
      ),
    ];

    for (const context of contexts) {
      if (context.value.workflow?.nodes?.length || context.value.workflow?.enabled) {
        addIssue(
          form.id,
          context.label,
          "unsupported",
          "原流程画布和运行语义保留在快照中，尚未转换为服务端流程。",
        );
      }
      const hasExtensions = Object.entries(context.value.extensions || {}).some(
        ([, value]) => value !== undefined && (!Array.isArray(value) || value.length),
      );
      if (hasExtensions) {
        addIssue(
          form.id,
          context.label,
          "unsupported",
          "扩展配置与停用状态保留，执行适配尚未完成。",
        );
      }
    }

    // 转换各历史发布版本
    for (const [version, variants] of [...catalog].sort(([a], [b]) => a - b)) {
      if (variants.length > 1) {
        addIssue(
          form.id,
          `V${version}`,
          "invalid",
          "同一发布版本存在不同内容，不能为旧记录任选一个版本。",
        );
      }
      const result =
        variants.length === 1
          ? projectFormSchema(form.id, `V${version}`, variants[0].schema, false)
          : undefined;

      if (variants.length === 1) {
        try {
          title(variants[0].title);
        } catch {
          addIssue(form.id, `V${version}`, "invalid", "历史表单名称无效。");
        }
        if (!isValidTime(variants[0].publishedAt)) {
          addIssue(
            form.id,
            `V${version}`,
            "invalid",
            "历史发布时间无效，不能替换成导入时间。",
          );
        }
      }

      projectedVersions.set(JSON.stringify([form.id, version]), result);
      versionPlans.push({
        sourceVersion: version,
        targetVersion: version,
        variants: variants.length,
        checked: !!result,
      });

      if (result) {
        converted.push({
          version,
          title: variants[0].title,
          publishedAt: variants[0].publishedAt,
          model: result.model,
          page: result.page,
        });
      }
    }

    // 转换表单访问权限与收集规则
    let accessConfig;
    {
      const before = issues.length;
      const result = migrateAccess(
        form.id,
        source.access[form.id] ?? {},
        contexts.map((context) => context.value.schema),
        choices,
        (kind, message, groupId, fieldId) =>
          addIssue(form.id, "访问权限", kind, message, {
            ...(groupId ? { groupId } : {}),
            ...(fieldId ? { fieldId } : {}),
          }),
      );
      access.push(result.summary);
      accessConfig = result.config;

      if (accessConfig?.publicEnabled) {
        addIssue(
          form.id,
          "访问权限",
          "unsupported",
          "公开填写尚未接通服务端，不能在导入时关闭原入口或改成成员入口。",
        );
      }
      if (
        accessConfig?.groups.some((group) =>
          group.subjects.some((subject) => subject.historical),
        )
      ) {
        addIssue(
          form.id,
          "访问权限",
          "mapping",
          "权限组引用了独立历史身份，需要明确的当前组织对应，不能为历史档案启用授权。",
        );
      }
      if (!form.published && accessConfig?.groups.length) {
        addIssue(
          form.id,
          "访问权限",
          "unsupported",
          "尚未发布表单的预设权限组需先接通，不能丢弃后导入。",
        );
      }
      if (accessConfig) {
        const publishedFields = new Set(
          converted.flatMap((version) =>
            version.model.fields.flatMap((field: any) => [
              field.id,
              ...field.children.map((child: any) => child.id),
            ]),
          ),
        );
        const hasUnpublishedFieldGrant = accessConfig.groups.some((group) =>
          Object.keys(group.fields).some((id) => !publishedFields.has(id)),
        );
        if (hasUnpublishedFieldGrant) {
          addIssue(
            form.id,
            "访问权限",
            "unsupported",
            "权限组仍引用未发布字段，需保留原配置，不能忽略该字段授权。",
          );
        }
      }
      if (accessConfig) {
        try {
          parseCollectionRules(accessConfig.filling);
        } catch (cause) {
          addIssue(form.id, "收集规则", "invalid", (cause as Error).message);
        }
      }
      result.summary.executionReady = !!accessConfig && issues.length === before;
    }

    // 校验记录列表视图配置
    let recordView;
    if (source.recordViews[form.id] !== undefined) {
      try {
        const fieldIds = new Set<string>(
          [
            ...(draft?.model.fields || []),
            ...converted.flatMap((version) => version.model.fields),
          ].map((field) => field.id),
        );
        recordView = validateRecordView(source.recordViews[form.id], fieldIds);
      } catch (cause) {
        addIssue(form.id, "列表设置", "invalid", (cause as Error).message);
      }
    }

    forms.push({
      sourceId: form.id,
      title: String(form.title || form.id),
      archived: !!form.archived,
      definitionId,
      pageId,
      versions: versionPlans,
      draftChecked: !!draft,
    });

    projection.forms.push({
      ...(fieldTrash ? { fieldTrash } : {}),
      ...(recordView ? { recordView } : {}),
      sourceId: form.id,
      definitionId,
      pageId,
      publishedVersion: form.published?.version ?? null,
      ...(draft ? { draft: { model: draft.model, page: draft.page } } : {}),
      ...(accessConfig ? { access: accessConfig } : {}),
      versions: converted,
    });
  }

  // 4. 逐条校验并投影历史记录与子表行数据
  const duplicateRecords = new Set(
    source.entries
      .filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) !== index)
      .map((entry) => entry.id),
  );

  for (const entry of source.entries as any[]) {
    const start = issues.length;
    const version = `V${entry.definitionVersion}`;
    const targetId = await reserve("record", [entry.formId, entry.id]);
    const rows: MigrationResourcePlan["records"][number]["rows"] = [];

    const report = (
      kind: "invalid" | "mapping" | "unsupported",
      message: string,
      extra: Partial<MigrationResourcePlan["issues"][number]> = {},
    ) => {
      addIssue(entry.formId, version, kind, message, { recordId: entry.id, ...extra });
    };

    if (duplicateRecords.has(entry.id)) {
      report("invalid", "记录身份重复，不能创建副本绕过冲突。");
    }

    const variants = sourceVersions.get(entry.formId)?.get(entry.definitionVersion);
    if (!variants) {
      report("invalid", "记录引用的发布版本不存在，不能用当前草稿替代。");
    } else if (variants.length !== 1) {
      report("invalid", "记录引用的发布版本有冲突，需先核对原发布内容。");
    }

    const validated = projectedVersions.get(
      JSON.stringify([entry.formId, entry.definitionVersion]),
    );
    if (!validated && variants?.length === 1) {
      report("unsupported", "此记录对应的历史字段定义尚未通过转换。");
    }

    // 仅使用第一个归档定义盘点子表行结构，当版本存在冲突时绝不执行值转换
    const originalSchema = variants?.[0]?.schema;
    const rawFields: any[] = Array.isArray(originalSchema?.fields) ? originalSchema.fields : [];
    const values: Record<string, any> = {};
    let creatorId: string | undefined;
    let departmentIds: string[] | undefined;

    try {
      object(entry.values);
    } catch {
      report("invalid", "记录值不是字段对象。");
    }

    const input =
      entry.values && typeof entry.values === "object" && !Array.isArray(entry.values)
        ? entry.values
        : {};

    // 盘点并预留子表行 UUID
    const subformFields = flattenNonTabFields(rawFields).filter(
      (field) => field.type === "subform",
    );
    for (const field of subformFields) {
      const rawRows = input[field.id];
      if (rawRows === undefined) continue;
      if (!Array.isArray(rawRows)) {
        report("invalid", "明细值不是行列表。", { fieldId: field.id });
        continue;
      }
      if (rawRows.length > maxSubformRows) {
        report(
          "unsupported",
          `明细超过当前服务端每条记录 ${maxSubformRows} 行的容量。`,
          { fieldId: field.id },
        );
      }

      const rowSet = new Set<string>();
      const digest = migrationDigest(rawRows);

      for (const [index, rawRow] of rawRows.entries()) {
        const originalRowId =
          rawRow &&
          typeof rawRow === "object" &&
          typeof rawRow._rowId === "string" &&
          rawRow._rowId
            ? rawRow._rowId
            : undefined;

        if (rawRow && Object.hasOwn(rawRow, "_rowId") && !originalRowId) {
          report("invalid", "原明细行身份格式无效，不能静默替换。", {
            fieldId: field.id,
            rowIndex: index,
          });
        }
        if (originalRowId && rowSet.has(originalRowId)) {
          report("invalid", "同一明细存在重复的原行身份。", {
            fieldId: field.id,
            rowIndex: index,
          });
        }
        if (originalRowId) {
          rowSet.add(originalRowId);
        }

        const rowKeyParts = originalRowId
          ? ["id", originalRowId]
          : ["snapshot", digest, index];
        const target = await reserve("row", [
          entry.formId,
          entry.id,
          field.id,
          ...rowKeyParts,
        ]);

        rows.push({
          fieldId: field.id,
          ...(originalRowId ? { sourceRowId: originalRowId } : {}),
          index,
          targetId: target,
        });
      }
    }

    // 校验并转换主表与子表字段值
    if (validated) {
      const required = entry.status !== "draft";
      const convertScalarValue = (field: FormField, value: unknown) =>
        scalar(field, mapOrganizationValue(field, value), required);

      for (const key of Object.keys(input)) {
        if (!validated.runtime.fields.some((field) => field.id === key)) {
          report("invalid", "记录包含该发布版本未定义的字段。", { fieldId: key });
        }
      }

      for (const field of validated.runtime.fields) {
        if (field.type !== "subform") {
          try {
            const value = convertScalarValue(field, input[field.id]);
            if (Object.hasOwn(input, field.id)) {
              values[field.id] = value;
            }
          } catch (cause) {
            report("invalid", (cause as Error).message, { fieldId: field.id });
          }
          continue;
        }

        if (!Object.hasOwn(input, field.id)) {
          if (required && field.required) {
            report("invalid", "必填明细缺失。", { fieldId: field.id });
          }
          continue;
        }
        if (!Array.isArray(input[field.id])) continue;
        if (required && field.required && !input[field.id].length) {
          report("invalid", "必填明细不能为空。", { fieldId: field.id });
        }

        values[field.id] = input[field.id].map((row: any, index: number) => {
          const targetRowId = rows.find(
            (item) => item.fieldId === field.id && item.index === index,
          )?.targetId;
          const result: Record<string, any> = { _rowId: targetRowId };

          if (!row || typeof row !== "object" || Array.isArray(row)) {
            report("invalid", "明细行不是字段对象。", {
              fieldId: field.id,
              rowIndex: index,
            });
            return result;
          }

          for (const key of Object.keys(row)) {
            if (key !== "_rowId" && !field.children.some((child) => child.id === key)) {
              report("invalid", "明细包含该发布版本未定义的列。", {
                fieldId: key,
                rowIndex: index,
              });
            }
          }

          for (const child of field.children) {
            try {
              const value = convertScalarValue(child, row[child.id]);
              if (Object.hasOwn(row, child.id)) {
                result[child.id] = value;
              }
            } catch (cause) {
              report("invalid", (cause as Error).message, {
                fieldId: child.id,
                rowIndex: index,
              });
            }
          }
          return result;
        });
      }
    }

    // 校验记录创建人、归属部门与历史生命周期状态
    try {
      if (!entry.createdBy) {
        throw new Error("历史创建者缺失，不能默认归给迁移操作者。");
      }
      creatorId = resolveMappedId("member", entry.createdBy);
    } catch (cause) {
      report("mapping", (cause as Error).message);
    }

    try {
      if (entry.createdDepartmentIds !== undefined) {
        if (!Array.isArray(entry.createdDepartmentIds)) {
          throw new Error("历史创建部门不是列表。");
        }
        departmentIds = entry.createdDepartmentIds.map((value: unknown) =>
          resolveMappedId("department", value),
        );
      }
    } catch (cause) {
      report("mapping", (cause as Error).message);
    }

    try {
      legacyRecordLifecycle(entry);
    } catch (cause) {
      report("invalid", (cause as Error).message);
    }

    if (Array.isArray(entry.history)) {
      historyEvents += entry.history.length;
    }

    const isInvalidNode =
      entry.currentNodeId &&
      variants?.length === 1 &&
      (!Array.isArray(variants[0].workflow?.nodes) ||
        !variants[0].workflow.nodes.some((node: any) => node?.id === entry.currentNodeId));
    if (isInvalidNode) {
      report("invalid", "当前处理节点不在记录引用的发布流程中。");
    }

    const checked = issues.length === start;
    records.push({
      sourceId: entry.id,
      formId: entry.formId,
      targetId,
      version: entry.definitionVersion,
      status: String(entry.status),
      deleted: !!entry.deletedAt,
      rows,
      checked,
    });

    if (checked) {
      projection.records.push({
        sourceId: entry.id,
        targetId,
        definitionId: forms.find((form) => form.sourceId === entry.formId)!.definitionId,
        version: entry.definitionVersion,
        values,
        creatorId,
        ...(departmentIds ? { createdDepartmentIds: departmentIds } : {}),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        deletedAt: entry.deletedAt,
        status: entry.status,
        history: entry.history,
        currentNodeId: entry.currentNodeId,
      });
    }
  }

  // 5. 汇总角色授权问题与未接通的运行资源提示
  if (roleReview) {
    issues.push(...roleReview.issues);
  } else if (source.roles.length) {
    addIssue("", "应用授权", "mapping", "请先核对来源角色与当前通讯录授权。");
  }

  if (source.orders.length || source.runs.length) {
    addIssue("", "运行资源", "unsupported", "支付订单与扩展运行轨迹已保留，执行适配尚未完成。");
  }

  return {
    projection,
    plan: {
      ...(roleReview
        ? {
            roleAuthorization: {
              signature: roleReview.signature,
              roleCount: roleReview.roleCount,
            },
          }
        : {}),
      targetApplicationId,
      forms,
      records,
      access,
      issues,
      totals: {
        forms: forms.length,
        versions: forms.reduce((sum, form) => sum + form.versions.length, 0),
        records: records.length,
        rows: records.reduce((sum, record) => sum + record.rows.length, 0),
        archivedForms: forms.filter((form) => form.archived).length,
        deletedRecords: records.filter((record) => record.deleted).length,
        draftRecords: records.filter((record) => record.status === "draft").length,
        historyEvents,
        orders: source.orders.length,
        runs: source.runs.length,
      },
    },
  };
}
