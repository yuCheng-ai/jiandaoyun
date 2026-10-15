import type { RecordViewSettings } from "./records";
import { defaultMobileLayout } from "@platform/contracts";
import { emptyOrganization, type Organization } from "./organization";
import type { FormExtensions, ExtensionRun, WebhookCredential } from "./extensions";
import {
  countCalculatedFields,
  fieldCountLimitError,
  emptySchema,
  uid,
  type FormSchema,
  type FormValues,
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
    version: 1,
    apps: [],
    forms: [],
    entries: [],
    recentFormIds: [],
    organization: emptyOrganization(),
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
