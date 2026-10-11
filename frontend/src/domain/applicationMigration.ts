import { visibilityConditions } from "./visibility";
import {
  dataKind,
  isChoiceField,
  isOrganizationField,
  serverFieldTypes,
  isDateFormat,
} from "@platform/contracts";
import {
  fieldRegistry,
  flattenFields,
  type FormField,
  type FormSchema,
} from "./form";
import type { FormExtensions } from "./extensions";
import type { FlowDocument } from "./workflow";
import type {
  FormRecord,
  PublishedDefinition,
  WorkspaceData,
} from "./workspace";

export type MigrationIssueKind = "invalid" | "unsupported" | "mapping";
export interface MigrationIssue {
  kind: MigrationIssueKind;
  formId: string;
  version: string;
  location: string;
  message: string;
  fieldId?: string;
}
export interface MigrationDependency {
  formId: string;
  version: string;
  location: string;
  targetId: string;
  targetTitle: string;
  targetApplication: string;
  targetVersion?: number;
  scope: "application" | "external" | "missing";
}
export interface MigrationFormInventory {
  id: string;
  title: string;
  archived: boolean;
  publishedVersions: number;
  versions: {
    label: string;
    fields: number;
    dataFields: number;
    layoutControls: number;
    workflowEnabled: boolean;
  }[];
  records: number;
  draftRecords: number;
  deletedRecords: number;
  rowCount: number;
  historyEvents: number;
  permissionGroups: number;
}
export interface ApplicationMigrationReport {
  application: { id: string; name: string };
  forms: MigrationFormInventory[];
  issues: MigrationIssue[];
  dependencies: MigrationDependency[];
  fieldTypes: {
    type: string;
    label: string;
    occurrences: number;
    runtimeSupported: boolean;
  }[];
  identities: {
    kind: "member" | "department" | "role";
    id: string;
    found: boolean;
  }[];
  paymentOrders: number;
  extensionRuns: number;
  inspectedAt: string;
}
interface SourceDefinition {
  label: string;
  schema: FormSchema;
  workflow: FlowDocument;
  extensions?: FormExtensions;
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const valueFields = (fields: FormField[]): FormField[] =>
  fields.flatMap((field) =>
    field.type === "tabs"
      ? valueFields(field.children)
      : dataKind(field.type) &&
          !(
            field.type === "relationTable" && field.reference.mode === "reverse"
          )
        ? [field]
        : [],
  );

/** Read-only inventory. It never creates target IDs, rewrites source data, or declares an import executable. */
export function inspectApplicationMigration(
  data: WorkspaceData,
  appId: string,
): ApplicationMigrationReport {
  const application = data.apps.find((app) => app.id === appId);
  if (!application) throw new Error("需要检查的应用不存在。");
  const forms = data.forms.filter((form) => form.appId === appId);
  const formIds = new Set(forms.map((form) => form.id));
  const report: ApplicationMigrationReport = {
    application: { id: application.id, name: application.name },
    forms: [],
    issues: [],
    dependencies: [],
    fieldTypes: [],
    identities: [],
    paymentOrders: (data.paymentOrders || []).filter((order) =>
      formIds.has(order.formId),
    ).length,
    extensionRuns: (data.extensionRuns || []).filter((run) =>
      formIds.has(run.formId),
    ).length,
    inspectedAt: new Date().toISOString(),
  };
  const identities = new Set<string>(),
    recordIds = new Set<string>();
  const issue = (
    formId: string,
    version: string,
    location: string,
    kind: MigrationIssueKind,
    message: string,
    fieldId?: string,
  ) => {
    report.issues.push({
      formId,
      version,
      location,
      kind,
      message,
      ...(fieldId ? { fieldId } : {}),
    });
  };
  const identity = (
    id: string,
    kind: "member" | "department" | "role",
    formId: string,
    version: string,
    location: string,
  ) => {
    if (!id) return;
    const key = `${kind}/${id}`;
    const items =
      kind === "member"
        ? data.organization.employees
        : kind === "department"
          ? data.organization.departments
          : data.organization.roles;
    const found = items.some((item) => item.id === id);
    if (!identities.has(key)) {
      identities.add(key);
      report.identities.push({ kind, id, found });
    }
    if (!found)
      issue(
        formId,
        version,
        location,
        "invalid",
        `引用的${kind === "member" ? "成员" : kind === "role" ? "角色" : "部门"}已不存在，需保留历史身份并明确映射。`,
      );
  };
  const mixedIdentity = (
    id: string,
    formId: string,
    version: string,
    location: string,
  ) =>
    identity(
      id,
      data.organization.roles.some((role) => role.id === id)
        ? "role"
        : data.organization.departments.some(
              (department) => department.id === id,
            )
          ? "department"
          : "member",
      formId,
      version,
      location,
    );
  const dependency = (
    form: FormRecord,
    version: string,
    location: string,
    targetId: string,
    targetVersion?: number,
    fieldIds: string[] = [],
  ) => {
    const target = data.forms.find((item) => item.id === targetId);
    const scope = !target
      ? "missing"
      : target.appId === appId
        ? "application"
        : "external";
    report.dependencies.push({
      formId: form.id,
      version,
      location,
      targetId,
      targetTitle: target?.title || "来源表单不存在",
      targetApplication:
        data.apps.find((app) => app.id === target?.appId)?.name || "",
      ...(targetVersion === undefined ? {} : { targetVersion }),
      scope,
    });
    if (!target) {
      issue(
        form.id,
        version,
        location,
        "invalid",
        "来源表单不存在，迁移不能丢弃这条关联。",
      );
      return;
    }
    if (scope === "external")
      issue(
        form.id,
        version,
        location,
        "mapping",
        `关联另一应用的「${target.title}」，需先映射或一并迁移其依赖。`,
      );
    const targetDefinition =
      targetVersion === undefined
        ? target.published
        : target.versions.find((item) => item.version === targetVersion) ||
          (target.published?.version === targetVersion
            ? target.published
            : undefined);
    if (!targetDefinition) {
      issue(
        form.id,
        version,
        location,
        "invalid",
        targetVersion === undefined
          ? "来源表单没有可用发布版本。"
          : `引用的来源版本 V${targetVersion} 不存在。`,
      );
      return;
    }
    const targetFields = new Set(
      flattenFields(targetDefinition.schema.fields).map((field) => field.id),
    );
    if (fieldIds.some((id) => id && !targetFields.has(id)))
      issue(
        form.id,
        version,
        location,
        "invalid",
        "来源版本中缺少引用的字段，需核对显示、筛选或回填配置。",
      );
  };

  for (const form of forms) {
    const published = new Map<number, PublishedDefinition>();
    const conflicts: PublishedDefinition[] = [];
    for (const version of [
      ...form.versions,
      ...(form.published ? [form.published] : []),
    ]) {
      const previous = published.get(version.version);
      if (previous && !same(previous, version)) {
        conflicts.push(version);
        issue(
          form.id,
          `V${version.version}`,
          "发布历史",
          "invalid",
          "同一版本存在不同发布内容，需要先确认正确的历史依据。",
        );
      } else published.set(version.version, version);
    }
    const sources: SourceDefinition[] = [
      {
        label: "草稿",
        schema: form.schema,
        workflow: form.workflow,
        extensions: form.extensions,
      },
      ...[...published.values()]
        .sort((a, b) => a.version - b.version)
        .map((version) => ({ ...version, label: `V${version.version}` })),
      ...conflicts.map((version, index) => ({
        ...version,
        label: `V${version.version}（冲突内容 ${index + 1}）`,
      })),
    ];
    const records = data.entries.filter((entry) => entry.formId === form.id);
    const inventory: MigrationFormInventory = {
      id: form.id,
      title: form.title,
      archived: form.archived,
      publishedVersions: published.size,
      versions: [],
      records: records.length,
      draftRecords: records.filter((entry) => entry.status === "draft").length,
      deletedRecords: records.filter((entry) => !!entry.deletedAt).length,
      rowCount: 0,
      historyEvents: records.reduce(
        (sum, entry) => sum + entry.history.length,
        0,
      ),
      permissionGroups: data.formAccess?.[form.id]?.groups.length || 0,
    };
    report.forms.push(inventory);
    for (const source of sources) {
      const fields = flattenFields(source.schema.fields),
        fieldIds = new Set(fields.map((field) => field.id));
      const layoutControls = fields.filter(
        (field) =>
          !dataKind(field.type) ||
          (field.type === "relationTable" &&
            field.reference.mode === "reverse"),
      ).length;
      inventory.versions.push({
        label: source.label,
        fields: fields.length,
        dataFields: fields.length - layoutControls,
        layoutControls,
        workflowEnabled: source.workflow.enabled,
      });
      if (fields.length !== fieldIds.size)
        issue(
          form.id,
          source.label,
          "字段结构",
          "invalid",
          "字段身份重复，不能按名称合并或重新生成来绕过。",
        );
      if (fields.length > 120 || source.schema.fields.length > 60)
        issue(
          form.id,
          source.label,
          "字段结构",
          "unsupported",
          "字段数量超过当前服务端单个定义的容量，需要扩展执行能力。",
        );
      if (source.schema.settings.rules.length)
        issue(
          form.id,
          source.label,
          "页面规则",
          "unsupported",
          "条件显隐规则尚未接入服务端页面。规则与引用必须一并保留。",
        );
      if (
        source.schema.settings.hiddenValues !== "retain" ||
        Object.keys(source.schema.settings.hiddenValueRules || {}).length
      )
        issue(
          form.id,
          source.label,
          "页面规则",
          "unsupported",
          "不可见字段赋值与特殊字段规则尚未接入共享页面。处理方式和字段引用必须一并保留。",
        );
      if (source.schema.settings.validations?.length)
        issue(
          form.id,
          source.label,
          "页面规则",
          "unsupported",
          "表单提交校验尚未接入服务端。条件、提示文字和字段引用必须一并保留。",
        );
      for (const rule of source.schema.settings.rules)
        if (
          visibilityConditions(rule).some(
            (condition) => !fieldIds.has(condition.sourceId),
          ) ||
          rule.targetIds.some((id) => !fieldIds.has(id))
        )
          issue(
            form.id,
            source.label,
            "页面规则",
            "invalid",
            "条件显隐引用了本版本不存在的字段。",
          );
      for (const field of fields) {
        const type = report.fieldTypes.find((item) => item.type === field.type);
        if (type) type.occurrences++;
        else
          report.fieldTypes.push({
            type: field.type,
            label:
              fieldRegistry.find((item) => item.type === field.type)?.label ||
              field.type,
            occurrences: 1,
            runtimeSupported: serverFieldTypes.includes(field.type),
          });
        const add = (kind: MigrationIssueKind, message: string) =>
          issue(form.id, source.label, field.label, kind, message, field.id);
        if (!serverFieldTypes.includes(field.type))
          add(
            "unsupported",
            `「${fieldRegistry.find((item) => item.type === field.type)?.label || field.type}」尚未接入服务端页面，原配置需完整保留。`,
          );
        if (field.unique)
          add("unsupported", "跨记录唯一性约束尚未接入服务端。");
        if (field.expression || field.defaultFormula)
          add("unsupported", "公式计算及其字段引用尚未接入服务端。");
        if (field.masked)
          add("unsupported", "掩码显示规则尚未接入服务端页面。");
        if (field.type === "datetime" && !isDateFormat(field.format))
          add("unsupported", "此日期格式尚未接入服务端。");
        if (field.type === "text" && !["none", "email"].includes(field.format))
          add("unsupported", "此文本格式尚未接入服务端。");
        if (
          field.type === "subform" &&
          (field.children.length > 40 ||
            flattenFields(field.children).some(
              (child) => child.type === "subform",
            ))
        )
          add("unsupported", "明细列数量或嵌套层级超出当前服务端范围。");
        if (field.defaultLink?.enabled) {
          add("unsupported", "默认值数据联动尚未接入服务端。");
          dependency(
            form,
            source.label,
            field.label,
            field.defaultLink.formId,
            undefined,
            [
              field.defaultLink.fieldId,
              ...(field.defaultLink.mappings || []).map((m) => m.sourceFieldId),
              ...field.defaultLink.filters.map(
                (filter) => filter.sourceFieldId,
              ),
            ],
          );
        }
        if (field.defaultRows !== undefined)
          add("unsupported", "子表默认明细尚未接入服务端。");
        if (isChoiceField(field.type) && field.choiceSource.mode === "form") {
          add("unsupported", "动态选项来源、筛选和级联行为尚未接入服务端。");
          dependency(
            form,
            source.label,
            field.label,
            field.choiceSource.formId,
            undefined,
            [
              field.choiceSource.labelFieldId,
              field.choiceSource.valueFieldId,
              ...field.choiceSource.filters.map(
                (filter) => filter.sourceFieldId,
              ),
            ],
          );
        }
        if (
          field.referenceFormId ||
          ["query", "lookup", "relation", "relationTable"].includes(field.type)
        ) {
          dependency(
            form,
            source.label,
            field.label,
            field.referenceFormId,
            undefined,
            [
              field.referenceFieldId,
              field.reference.reverseFieldId,
              ...field.reference.columns,
              ...(field.reference.displayColumns || []),
              ...(field.reference.sort &&
              !field.reference.sort.fieldId.startsWith("$")
                ? [field.reference.sort.fieldId]
                : []),
              ...field.reference.mappings.map(
                (mapping) => mapping.sourceFieldId,
              ),
              ...field.reference.filters.map((filter) => filter.sourceFieldId),
            ],
          );
        }
        if (
          ["member", "members", "department", "departments"].includes(
            field.type,
          )
        ) {
          const scope = field.organization.scope;
          scope.employeeIds.forEach((id) =>
            identity(id, "member", form.id, source.label, field.label),
          );
          scope.departmentIds.forEach((id) =>
            identity(id, "department", form.id, source.label, field.label),
          );
          scope.roleIds.forEach((id) =>
            identity(id, "role", form.id, source.label, field.label),
          );
          field.organization.defaultIds.forEach((id) =>
            identity(
              id,
              field.type.startsWith("department") ? "department" : "member",
              form.id,
              source.label,
              field.label,
            ),
          );
        }
      }
      // Disabled workflows and extension configurations are still migration resources.
      if (source.workflow.nodes.length)
        issue(
          form.id,
          source.label,
          "流程配置",
          "unsupported",
          `${source.workflow.enabled ? "已启用" : "未启用"}的流程画布、节点权限及处理规则需整体迁移。`,
        );
      for (const node of source.workflow.nodes) {
        node.data.members.forEach((id) =>
          mixedIdentity(id, form.id, source.label, `流程 · ${node.data.label}`),
        );
        if (
          Object.keys(node.data.permissions).some((id) => !fieldIds.has(id)) ||
          (node.data.conditionFieldId &&
            !fieldIds.has(node.data.conditionFieldId))
        )
          issue(
            form.id,
            source.label,
            `流程 · ${node.data.label}`,
            "invalid",
            "节点权限或条件引用了本版本不存在的字段。",
          );
        if (node.data.kind === "subflow" && node.data.subflow)
          dependency(
            form,
            source.label,
            `子流程 · ${node.data.label}`,
            node.data.subflow,
          );
      }
      const extensionNames: Record<keyof FormExtensions, string> = {
        webhooks: "数据推送",
        automations: "智能助手",
        reminders: "提醒",
        buttons: "自定义按钮",
        printTemplates: "打印模板",
        payment: "支付配置",
        quickFill: "快捷填报",
        collaboration: "数据标题与快捷编辑",
        detail: "详情展示",
      };
      for (const [key, value] of Object.entries(source.extensions || {})) {
        if (value !== undefined && (!Array.isArray(value) || value.length))
          issue(
            form.id,
            source.label,
            extensionNames[key as keyof FormExtensions] || "扩展配置",
            "unsupported",
            "配置及停用状态需保留，当前整体迁移执行尚未接通。",
          );
      }
      for (const automation of source.extensions?.automations || [])
        for (const [index, step] of automation.steps.entries())
          dependency(
            form,
            source.label,
            `智能助手 · ${automation.name} / ${step.name || `动作 ${index + 1}`}`,
            step.targetFormId,
            step.targetVersion,
            [
              ...step.mappings.map((mapping) => mapping.targetId),
              ...step.filters.map((filter) => filter.sourceFieldId),
            ],
          );
      for (const button of source.extensions?.buttons || [])
        if (button.action === "openForm")
          dependency(
            form,
            source.label,
            `按钮 · ${button.name}`,
            button.targetFormId,
            undefined,
            button.mappings.map((mapping) => mapping.targetId),
          );
      for (const webhook of source.extensions?.webhooks || [])
        if (
          webhook.credentialRef &&
          !data.webhookCredentials?.some(
            (credential) => credential.id === webhook.credentialRef,
          )
        )
          issue(
            form.id,
            source.label,
            "数据推送",
            "invalid",
            "引用的签名凭证不存在；检查只核对引用，不复制密钥内容。",
          );
      for (const reminder of source.extensions?.reminders || [])
        if (reminder.recipients.source === "fixed")
          reminder.recipients.ids.forEach((id) =>
            mixedIdentity(id, form.id, source.label, `提醒 · ${reminder.name}`),
          );
    }
    if (data.formAccess?.[form.id]) {
      issue(
        form.id,
        "应用设置",
        "访问权限",
        "mapping",
        "填写入口、数据范围与操作权限需映射到服务端；不能自动改为管理员或公开访问。",
      );
      for (const group of data.formAccess[form.id].groups) {
        group.identities.forEach((id) =>
          mixedIdentity(id, form.id, "应用设置", `权限组 · ${group.name}`),
        );
        // A filter may be the only remaining reference to a departed member or department.
        // Inspect historical definitions too; never infer identities from a display name.
        for (const filter of group.filters) {
          if (
            filter.source !== "constant" ||
            !filter.value ||
            !["equals", "notEquals"].includes(filter.operator)
          )
            continue;
          for (const source of sources) {
            const field = flattenFields(source.schema.fields).find(
              (item) => item.id === filter.sourceFieldId,
            );
            if (field && isOrganizationField(field.type))
              identity(
                filter.value,
                field.type.startsWith("department") ? "department" : "member",
                form.id,
                source.label,
                `权限组筛选 · ${group.name}`,
              );
          }
        }
      }
    }
    if (data.recordViews?.[form.id])
      issue(
        form.id,
        "应用设置",
        "数据视图",
        "mapping",
        "列表字段、排序和分页配置需随表单保留。",
      );
    for (const entry of records) {
      const location = `记录 ${entry.id}`,
        version = `V${entry.definitionVersion}`;
      if (recordIds.has(entry.id))
        issue(
          form.id,
          version,
          location,
          "invalid",
          "记录身份重复，不能以新建副本代替原记录迁移。",
        );
      recordIds.add(entry.id);
      const definition = published.get(entry.definitionVersion);
      if (!definition) {
        issue(
          form.id,
          version,
          location,
          "invalid",
          "记录引用的发布版本不存在，不能改用当前草稿解释旧值。",
        );
        continue;
      }
      if (
        !entry.values ||
        typeof entry.values !== "object" ||
        Array.isArray(entry.values)
      ) {
        issue(
          form.id,
          version,
          location,
          "invalid",
          "记录值结构不合法，需保留原内容并核对，不能按空记录迁移。",
        );
        continue;
      }
      const schema = valueFields(definition.schema.fields);
      const recordIdentity = (field: FormField, value: unknown) => {
        if (
          ["member", "members", "department", "departments"].includes(
            field.type,
          )
        )
          for (const id of Array.isArray(value) ? value : value ? [value] : [])
            if (typeof id === "string")
              identity(
                id,
                field.type.startsWith("department") ? "department" : "member",
                form.id,
                version,
                location,
              );
      };
      if (
        Object.keys(entry.values).some(
          (id) => !schema.some((field) => field.id === id),
        )
      )
        issue(
          form.id,
          version,
          location,
          "invalid",
          "记录包含对应发布版本未定义的字段，需保留原值并核对来源。",
        );
      for (const field of schema) {
        const value = entry.values[field.id];
        recordIdentity(field, value);
        if (
          field.type === "subform" &&
          value !== undefined &&
          !Array.isArray(value)
        )
          issue(
            form.id,
            version,
            location,
            "invalid",
            "明细值不是行列表，需保留原内容并核对，不能按空明细迁移。",
            field.id,
          );
        if (field.type === "subform" && Array.isArray(value)) {
          inventory.rowCount += value.length;
          const children = valueFields(field.children);
          if (
            value.some(
              (row) =>
                !row ||
                typeof row !== "object" ||
                Array.isArray(row) ||
                Object.keys(row).some(
                  (id) =>
                    id !== "_rowId" &&
                    !children.some((child) => child.id === id),
                ),
            )
          )
            issue(
              form.id,
              version,
              location,
              "invalid",
              "明细包含对应发布版本未定义的列或行结构，不能静默丢弃。",
              field.id,
            );
          for (const row of value)
            if (row && typeof row === "object" && !Array.isArray(row))
              for (const child of children)
                recordIdentity(child, row[child.id]);
        }
      }
      if (entry.createdBy)
        identity(entry.createdBy, "member", form.id, version, location);
      else
        issue(
          form.id,
          version,
          location,
          "mapping",
          "历史记录缺少创建者，需要明确历史身份归属；不能默认归给迁移操作者。",
        );
      entry.createdDepartmentIds?.forEach((id) =>
        identity(id, "department", form.id, version, location),
      );
      if (
        entry.currentNodeId &&
        !definition.workflow.nodes.some(
          (node) => node.id === entry.currentNodeId,
        )
      )
        issue(
          form.id,
          version,
          location,
          "invalid",
          "记录当前节点不在对应发布流程中，需保留并核对运行状态。",
        );
    }
  }
  for (const role of data.organization.roles)
    if (
      role.grants.some(
        (grant) =>
          grant.appId === appId || grant.formIds.some((id) => formIds.has(id)),
      )
    ) {
      identity(role.id, "role", "", "应用设置", "角色授权");
      role.memberIds.forEach((id) =>
        identity(id, "member", "", "应用设置", "角色成员"),
      );
      role.departmentIds.forEach((id) =>
        identity(id, "department", "", "应用设置", "角色部门"),
      );
      issue(
        "",
        "应用设置",
        "角色授权",
        "mapping",
        `「${role.name}」的应用与表单授权需保留范围后建立身份映射。`,
      );
    }
  return report;
}
