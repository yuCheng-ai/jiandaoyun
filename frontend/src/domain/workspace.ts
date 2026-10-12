import type { WebhookCredential } from "./webhookSecurity";
import type { RecordViewSettings } from "./records";
import { defaultMobileLayout } from "@platform/contracts";
import { seedOrganization, type Organization } from "./organization";
import type { FormExtensions, ExtensionRun } from "./extensions";
import {
  createField,
  countCalculatedFields,
  fieldCountLimitError,
  emptySchema,
  uid,
  type FormSchema,
  type FormValues,
  type FormField,
  type VisibilityRule,
} from "./form";
import {
  initialDocument,
  nextFlowEdge,
  type FlowDocument,
  type FlowNode,
} from "./workflow";
export interface WorkspaceApp {
  id: string;
  name: string;
  color: string;
  icon: string;
  folders: string[];
  description: string;
}
export interface PublishedDefinition {
  extensions?: FormExtensions;
  version: number;
  title: string;
  schema: FormSchema;
  workflow: FlowDocument;
  publishedAt: string;
}
import type { RecycledField } from '@platform/contracts';
export type { RecycledField } from '@platform/contracts';
export interface FormRecord {
  fieldTrash?: RecycledField[];
  extensions?: FormExtensions;
  id: string;
  appId: string;
  title: string;
  kind: "form" | "workflow";
  folder: string;
  schema: FormSchema;
  workflow: FlowDocument;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  published?: PublishedDefinition;
  versions: PublishedDefinition[];
}
export interface FormEntry {
  /** Ephemeral member read projection; never a persisted permission grant. */
  readableFieldIds?: string[];
  createdBy?: string;
  createdDepartmentIds?: string[];
  reminderReceipts?: string[];
  deletedAt?: string;
  updatedAt?: string;
  pluginError?: string;
  id: string;
  formId: string;
  definitionVersion: number;
  values: FormValues;
  createdAt: string;
  status: "draft" | "submitted" | "approved" | "rejected";
  currentNodeId?: string;
  history: { label: string; action: string; time: string }[];
}
export interface WorkspaceData {
  serialCounters?: import("./serial").SerialCounters;
  formAccess?: Record<string, import("./access").FormAccess>;
  recordViews?: Record<string, RecordViewSettings>;
  webhookCredentials?: WebhookCredential[];
  extensionRuns?: ExtensionRun[];
  organization: Organization;
  version: 1;
  apps: WorkspaceApp[];
  forms: FormRecord[];
  entries: FormEntry[];
  recentFormIds: string[];
}
/** Empty rendering context for server-backed forms; never reads browser business data. */
export function emptyWorkspace(): WorkspaceData {
  return {
    version: 1, apps: [], forms: [], entries: [], recentFormIds: [],
    organization: {
      version: 1, name: "组织与成员", currentUserId: "",
      departments: [], employees: [], roles: [], roleGroups: [],
    },
  };
}
/** Archived forms still exist; only removing their active calculations releases capacity. */
export function formFieldLimitError(
  form: Pick<FormRecord, "id" | "appId" | "schema">,
  forms: readonly FormRecord[],
): string {
  const previous = forms.find((item) => item.id === form.id);
  const fieldError = fieldCountLimitError(
    form.schema.fields,
    previous?.schema.fields,
  );
  if (fieldError) return fieldError;
  if (
    !countCalculatedFields(form.schema.fields) ||
    countCalculatedFields(previous?.schema.fields || [])
  )
    return "";
  const others = forms.filter(
    (item) =>
      item.id !== form.id &&
      item.appId === form.appId &&
      countCalculatedFields(item.schema.fields),
  );
  return others.length >= 100 ? "单个应用最多 100 个含计算字段的表单" : "";
}
export function newForm(
  appId: string,
  title: string,
  kind: FormRecord["kind"] = "form",
  folder = "",
): FormRecord {
  const now = new Date().toISOString();
  const workflow = initialDocument();
  workflow.title = title;
  const schema = emptySchema();
  if (kind === "form")
    Object.assign(schema.settings, {
      hiddenValueRules: {},
      labelWidth: 80,
      labelAlignment: "left",
      descriptionMode: "show",
      inputWidth: "standard",
      mobileLayout: defaultMobileLayout(),
      externalStyle: { theme: 0 },
    });
  return {
    id: uid("form"),
    appId,
    title,
    kind,
    folder,
    schema,
    workflow,
    createdAt: now,
    updatedAt: now,
    archived: false,
    versions: [],
    extensions: { webhooks: [] },
  };
}
export function seedWorkspace(): WorkspaceData {
  const apps: WorkspaceApp[] = [
    {
      id: "oa",
      name: "OA审批系统",
      color: "#56ae72",
      icon: "department",
      folders: ["行政类", "人事类", "财务类", "其他"],
      description: "让日常办公和团队协作更高效",
    },
    {
      id: "product",
      name: "产品需求管理",
      color: "#f1af56",
      icon: "layers",
      folders: ["需求管理", "项目协作"],
      description: "从需求收集到项目交付",
    },
    {
      id: "production",
      name: "生产流转管理",
      color: "#548ddb",
      icon: "settings",
      folders: ["生产计划", "质量检查"],
      description: "连接生产流程与质量数据",
    },
    {
      id: "quality",
      name: "质量管理",
      color: "#a777d4",
      icon: "success",
      folders: ["质量巡检"],
      description: "记录问题，跟踪改善",
    },
    {
      id: "assets",
      name: "资产管理",
      color: "#53b0bd",
      icon: "database",
      folders: ["资产台账"],
      description: "管理团队的设备和物资",
    },
    {
      id: "tickets",
      name: "工单管理",
      color: "#dc7d87",
      icon: "form",
      folders: ["工单中心"],
      description: "接收需求，及时响应",
    },
  ];
  const expense = newForm("oa", "费用报销", "workflow", "财务类");
  expense.id = "expense";
  expense.schema.fields = [
    createField("member", { id: "applicant", label: "申请人", required: true }),
    createField("department", {
      id: "department",
      label: "申请部门",
      required: true,
    }),
    createField("datetime", { id: "date", label: "申请日期", required: true }),
    createField("number", {
      id: "amount",
      label: "申请金额",
      required: true,
      min: 0,
    }),
    createField("textarea", { id: "note", label: "申请说明" }),
  ];
  const leave = newForm("oa", "请假申请", "workflow", "人事类");
  leave.id = "leave";
  leave.schema.fields = [
    createField("member", {
      id: "leave_applicant",
      label: "申请人",
      required: true,
    }),
    createField("select", {
      id: "leave_type",
      label: "请假类型",
      required: true,
      options: ["事假", "病假", "年假", "调休"].map((label) => ({
        id: uid("option"),
        label,
      })),
    }),
    createField("datetime", {
      id: "leave_start",
      label: "开始时间",
      format: "datetime-local",
      width: 6,
      required: true,
    }),
    createField("datetime", {
      id: "leave_end",
      label: "结束时间",
      format: "datetime-local",
      width: 6,
      required: true,
    }),
    createField("textarea", {
      id: "leave_reason",
      label: "请假事由",
      required: true,
    }),
  ];
  const employee = newForm("oa", "员工详情", "form", "人事类");
  employee.id = "employee";
  employee.schema.fields = [
    createField("text", { label: "姓名", required: true }),
    createField("phone", { label: "手机号码", required: true }),
    createField("department", { label: "所属部门" }),
    createField("datetime", { label: "入职日期" }),
  ];
  const unnamed = newForm("oa", "未命名表单", "workflow", "其他");
  unnamed.id = "untitled";
  unnamed.schema.fields = [
    createField("text", { id: "sample_text", label: "单行文本" }),
    createField("number", { id: "sample_number", label: "数字" }),
  ];
  const supplies = newForm("oa", "办公用品申请", "workflow", "行政类");
  supplies.id = "supplies";
  const items = createField("subform", { label: "物品明细" });
  items.children = [
    createField("text", { label: "物品名称", required: true }),
    createField("number", { label: "数量", required: true, min: 1 }),
    createField("textarea", { label: "备注" }),
  ];
  supplies.schema.fields = [
    createField("member", { label: "申请人", required: true }),
    items,
  ];
  const forms = [
    leave,
    employee,
    expense,
    supplies,
    unnamed,
    ...apps
      .slice(1)
      .map((app) =>
        newForm(app.id, `${app.folders[0]}表单`, "form", app.folders[0]),
      ),
  ];
  return {
    version: 1,
    organization: seedOrganization(),
    apps,
    forms,
    entries: [],
    recentFormIds: ["leave", "employee", "untitled"],
  };
}

/** Local demonstration runner; external plugin/subflow execution belongs to a server adapter. */
export function advanceEntry(
  entry: FormEntry,
  flow: FlowDocument,
  action: "start" | "approved" | "rejected" | "retry",
  executePlugin?: (node: FlowNode, values: FormValues) => ExtensionRun,
) {
  const now = new Date().toISOString();
  let node = flow.nodes.find(
    (n) =>
      n.id ===
      (action === "start"
        ? flow.nodes.find((n) => n.data.kind === "start")?.id
        : entry.currentNodeId),
  );
  if (action !== "start" && action !== "retry")
    entry.history.push({
      label: node?.data.label || "审批节点",
      action: action === "rejected" ? "退回申请" : "同意",
      time: now,
    });
  if (action === "rejected") {
    entry.status = "rejected";
    return;
  }
  if (node && action !== "retry")
    node = flow.nodes.find(
      (n) => n.id === nextFlowEdge(flow, node!, entry.values)?.target,
    );
  entry.currentNodeId = undefined;
  entry.pluginError = undefined;
  const visited = new Set<string>();
  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    if (node.data.kind === "approval") {
      entry.currentNodeId = node.id;
      entry.status = "submitted";
      return;
    }
    if (node.data.kind === "plugin") {
      const result = executePlugin?.(node, entry.values);
      if (!result || result.status !== "success") {
        entry.currentNodeId = node.id;
        entry.status = "submitted";
        entry.pluginError = result?.error?.message || "插件未配置执行器";
        entry.history.push({
          label: node.data.label,
          action: `执行失败：${entry.pluginError}`,
          time: now,
        });
        return;
      }
      entry.values = { ...entry.values, ...result.mappedValues };
      entry.history.push({
        label: node.data.label,
        action:
          result.mode === "simulation"
            ? "模拟执行成功并回填"
            : "本地执行成功并回填",
        time: now,
      });
    } else
      entry.history.push({
        label: node.data.label,
        action:
          node.data.kind === "end"
            ? "审批完成"
            : node.data.kind === "condition"
              ? "条件判断"
              : "本地模拟通过",
        time: now,
      });
    if (node.data.kind === "end") {
      entry.status = "approved";
      return;
    }
    const nextId = nextFlowEdge(flow, node, entry.values)?.target;
    node = flow.nodes.find((n) => n.id === nextId);
  }
  entry.status = "submitted";
  entry.pluginError = "流程未能到达结束节点，请检查连线";
}
