import { resolveIdentities, type Organization } from "./organization";
import {
  newInvocation,
  parseInvocation,
  validateInvocation,
  type PluginInvocation,
} from "./extensions";
import type { FormSchema } from "./form";
import { type MarkerType, type Node, type Edge } from "@vue-flow/core";

export type NodeKind =
  "start" | "approval" | "copy" | "condition" | "subflow" | "plugin" | "end";
export type Permission = "edit" | "read" | "hidden";
export type PermissionColumn = "visible" | "editable" | "brief";
export interface NodeData {
  kind: NodeKind;
  label: string;
  ownerMode: string;
  members: string[];
  copyEnabled: boolean;
  aiEnabled: boolean;
  submitRule: string;
  multiRule: string;
  missingRule: string;
  timeout: number;
  timeoutAction: string;
  permissions: Record<string, Permission>;
  briefFields: string[];
  actions: string[];
  condition: string;
  conditionFieldId: string;
  subflow: string;
  plugin: string;
  pluginConfig?: PluginInvocation;
}
export type FlowNode = Pick<
  Node,
  "id" | "position" | "type" | "deletable" | "draggable" | "selectable"
> & { data: NodeData; selected?: boolean };
export interface FlowSettings {
  allowWithdraw: boolean;
  notify: boolean;
  deduplicate: boolean;
  reminderChannels: string[];
  viewProgress: boolean;
  allowUrge: boolean;
  withdrawRule: "none" | "start" | "all";
  autoSubmitRule: "off" | "previous" | "handled";
}
export interface FlowDocument {
  schemaVersion: 1;
  title: string;
  description: string;
  enabled: boolean;
  version: number;
  formFields?: { id: string; label: string }[];
  settings: FlowSettings;
  nodes: FlowNode[];
  edges: Edge[];
}
export const kindLabels: Record<NodeKind, string> = {
  start: "流程发起节点",
  approval: "流程节点",
  copy: "抄送节点",
  condition: "条件分支",
  subflow: "子流程",
  plugin: "插件节点",
  end: "流程结束",
};
export const fields = [
  "申请人",
  "申请部门",
  "申请日期",
  "申请金额",
  "申请说明",
];
export function makeNode(
  id: string,
  kind: NodeKind,
  x: number,
  y: number,
): FlowNode {
  return {
    id,
    type: "workflow",
    position: { x, y },
    deletable: kind !== "start" && kind !== "end",
    data: {
      kind,
      label: kindLabels[kind],
      ownerMode: "regular",
      members: [],
      copyEnabled: false,
      aiEnabled: false,
      submitRule: "all",
      multiRule: "any",
      missingRule: "stop",
      timeout: 0,
      timeoutAction: "remind",
      permissions: Object.fromEntries(
        fields.map((field) => [field, "edit"]),
      ) as Record<string, Permission>,
      briefFields: [],
      actions:
        kind === "start"
          ? ["提交", "保存草稿", "暂存"]
          : ["同意", "退回", "转交"],
      condition: "申请金额 > 5000",
      conditionFieldId: "",
      subflow: "",
      plugin: "",
    },
  };
}
export function makeEdge(
  source: string,
  target: string,
  extra: Partial<Edge> = {},
): Edge {
  return {
    id: `e-${source}-${target}-${extra.sourceHandle || "bottom"}`,
    source,
    target,
    sourceHandle: "bottom",
    targetHandle: "top",
    type: "smoothstep",
    style: { stroke: "#3478ff", strokeWidth: 1.7 },
    markerEnd: {
      type: "arrowclosed" as MarkerType,
      color: "#3478ff",
      width: 16,
      height: 16,
    },
    pathOptions: { borderRadius: 12, offset: 26 },
    ...extra,
  } as Edge;
}
export function initialDocument(): FlowDocument {
  return {
    schemaVersion: 1,
    title: "未命名表单",
    description: "",
    enabled: false,
    version: 1,
    settings: {
      allowWithdraw: false,
      notify: false,
      deduplicate: false,
      reminderChannels: [],
      viewProgress: true,
      allowUrge: false,
      withdrawRule: "none",
      autoSubmitRule: "off",
    },
    nodes: [
      makeNode("start", "start", 28, 56),
      makeNode("1", "approval", 0, 242),
      makeNode("end", "end", 28, 356),
    ],
    edges: [makeEdge("start", "1"), makeEdge("1", "end")],
  };
}
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
export function changeFieldAccess(
  data: NodeData,
  selectedFields: string[],
  column: PermissionColumn,
  enabled: boolean,
): Pick<NodeData, "permissions" | "briefFields"> {
  const permissions = { ...data.permissions };
  const brief = new Set(data.briefFields);
  for (const field of selectedFields.filter((f) =>
    Object.hasOwn(data.permissions, f),
  )) {
    if (column === "visible") {
      permissions[field] = enabled
        ? permissions[field] === "edit"
          ? "edit"
          : "read"
        : "hidden";
      if (!enabled) brief.delete(field);
    } else if (column === "editable") {
      permissions[field] = enabled
        ? "edit"
        : permissions[field] === "hidden"
          ? "hidden"
          : "read";
    } else if (enabled) {
      brief.add(field);
      if (permissions[field] === "hidden") permissions[field] = "read";
    } else brief.delete(field);
  }
  return { permissions, briefFields: [...brief] };
}
export function serialize(doc: FlowDocument): string {
  return JSON.stringify({
    ...doc,
    nodes: doc.nodes.map((n) => ({
      id: n.id,
      type: "workflow",
      position: { x: n.position.x, y: n.position.y },
      data: n.data,
      deletable: n.data.kind !== "start" && n.data.kind !== "end",
    })),
    edges: doc.edges.map((e) =>
      makeEdge(e.source, e.target, {
        id: e.id,
        sourceHandle: e.sourceHandle || "bottom",
        targetHandle: e.targetHandle || "top",
        label: typeof e.label === "string" && e.label ? e.label : undefined,
      }),
    ),
  });
}
export function reaches(from: string, to: string, edges: Edge[]): boolean {
  const visited = new Set<string>(),
    stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...edges.filter((e) => e.source === id).map((e) => e.target));
  }
  return false;
}
export function connectionError(
  source: string,
  target: string,
  doc: FlowDocument,
): string | null {
  const from = doc.nodes.find((n) => n.id === source),
    to = doc.nodes.find((n) => n.id === target);
  if (!from || !to) return "找不到连接的节点";
  if (source === target) return "节点不能连接自身";
  if (from.data.kind === "end" || to.data.kind === "start")
    return "请按从发起到结束的方向连接";
  if (doc.edges.some((e) => e.source === source && e.target === target))
    return "这两个节点已经连接";
  if (reaches(target, source, doc.edges))
    return "这条连线会形成循环，请选择其他节点";
  if (
    from.data.kind !== "condition" &&
    doc.edges.some((e) => e.source === source)
  )
    return "已有后续节点；请先删除连线，或添加条件分支";
  if (
    from.data.kind === "condition" &&
    doc.edges.filter((e) => e.source === source).length >= 2
  )
    return "当前条件分支支持两个出口，请先删除需要替换的连线";
  return null;
}
export interface ValidationIssue {
  nodeId?: string;
  message: string;
}
export function validate(
  doc: FlowDocument,
  organization?: Organization,
  schema?: FormSchema,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const starts = doc.nodes.filter((n) => n.data.kind === "start"),
    ends = doc.nodes.filter((n) => n.data.kind === "end");
  if (!doc.title.trim()) issues.push({ message: "请填写表单名称" });
  if (starts.length !== 1 || ends.length !== 1)
    return [{ message: "流程必须有且仅有一个发起节点和结束节点" }];
  const start = starts[0]!,
    end = ends[0]!;
  for (const node of doc.nodes) {
    const outgoing = doc.edges.filter((e) => e.source === node.id);
    if (!node.data.label.trim())
      issues.push({ nodeId: node.id, message: "节点名称不能为空" });
    if (
      !reaches(start.id, node.id, doc.edges) ||
      !reaches(node.id, end.id, doc.edges)
    )
      issues.push({
        nodeId: node.id,
        message: `「${node.data.label}」未接入完整流程`,
      });
    if (
      node.data.kind === "approval" &&
      node.data.ownerMode === "regular" &&
      !node.data.members.length
    )
      issues.push({
        nodeId: node.id,
        message: `请为「${node.data.label}」选择节点负责人`,
      });
    if (
      organization &&
      ["approval", "copy"].includes(node.data.kind) &&
      node.data.ownerMode === "regular" &&
      node.data.members.length &&
      !resolveIdentities(organization, node.data.members).length
    )
      issues.push({
        nodeId: node.id,
        message: `「${node.data.label}」所选负责人中没有在职成员，请重新选择`,
      });
    if (node.data.kind === "copy" && !node.data.members.length)
      issues.push({
        nodeId: node.id,
        message: `请为「${node.data.label}」选择抄送成员`,
      });
    if (node.data.kind === "condition" && outgoing.length !== 2)
      issues.push({
        nodeId: node.id,
        message: `「${node.data.label}」需要两个分支：满足条件和其他情况`,
      });
    if (
      node.data.kind === "condition" &&
      !/^申请金额\s*(>=|<=|>|<|==)\s*\d+(\.\d+)?$/.test(node.data.condition)
    )
      issues.push({
        nodeId: node.id,
        message: `「${node.data.label}」请设置有效的金额条件`,
      });
    if (node.data.kind === "subflow" && !node.data.subflow)
      issues.push({
        nodeId: node.id,
        message: `请为「${node.data.label}」选择子流程`,
      });
    if (node.data.kind === "plugin" && !node.data.plugin)
      issues.push({
        nodeId: node.id,
        message: `请为「${node.data.label}」选择插件`,
      });
    if (node.data.kind === "plugin" && node.data.plugin && schema)
      issues.push(
        ...validateInvocation(
          node.data.pluginConfig || newInvocation(node.data.plugin),
          schema,
        ).map((i) => ({
          nodeId: node.id,
          message: `${node.data.label}：${i.message}`,
        })),
      );
    if (
      node.data.kind !== "condition" &&
      node.data.kind !== "end" &&
      outgoing.length > 1
    )
      issues.push({
        nodeId: node.id,
        message: `「${node.data.label}」存在多个出口，请使用条件分支`,
      });
    if (outgoing.some((e) => reaches(e.target, node.id, doc.edges)))
      issues.push({
        nodeId: node.id,
        message: `「${node.data.label}」存在循环连线`,
      });
  }
  return issues;
}
export function removeNode(doc: FlowDocument, id: string): void {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node || ["start", "end"].includes(node.data.kind)) return;
  const incoming = doc.edges.filter((e) => e.target === id),
    outgoing = doc.edges.filter((e) => e.source === id);
  doc.nodes = doc.nodes.filter((n) => n.id !== id);
  doc.edges = doc.edges.filter((e) => e.source !== id && e.target !== id);
  // Reconnect a single successor. Complex branches remain explicit to avoid creating accidental routes.
  if (outgoing.length === 1)
    for (const edge of incoming) {
      if (
        !doc.edges.some(
          (e) => e.source === edge.source && e.target === outgoing[0]!.target,
        )
      ) {
        doc.edges.push(
          makeEdge(edge.source, outgoing[0]!.target, {
            sourceHandle: edge.sourceHandle,
            targetHandle: outgoing[0]!.targetHandle,
            label: edge.label,
          }),
        );
      }
    }
}
export function parseDocument(text: string): FlowDocument {
  const raw = JSON.parse(text);
  if (
    raw?.schemaVersion !== 1 ||
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.edges) ||
    typeof raw.title !== "string" ||
    raw.nodes.length > 500 ||
    raw.edges.length > 1000
  )
    throw new Error("文件不是有效的流程 JSON（支持版本 1，最多 500 个节点）");
  const ids = new Set<string>();
  const nodes = raw.nodes.map((node: any) => {
    if (
      typeof node.id !== "string" ||
      ids.has(node.id) ||
      !Object.hasOwn(kindLabels, node.data?.kind) ||
      typeof node.data?.label !== "string" ||
      !Number.isFinite(node.position?.x) ||
      !Number.isFinite(node.position?.y)
    )
      throw new Error("节点数据不完整或节点 ID 重复");
    ids.add(node.id);
    const base = makeNode(
      node.id,
      node.data.kind,
      node.position.x,
      node.position.y,
    );
    for (const key of Object.keys(base.data) as (keyof NodeData)[]) {
      const value = node.data[key];
      if (Array.isArray(base.data[key])) {
        if (Array.isArray(value) && value.every((v) => typeof v === "string"))
          (base.data as any)[key] = value;
      } else if (typeof base.data[key] === "object") {
        if (
          value &&
          typeof value === "object" &&
          Object.values(value).every((v) =>
            ["read", "edit", "hidden"].includes(v as string),
          )
        )
          base.data.permissions = Object.fromEntries(
            Object.entries(value).filter(
              ([k]) => !["__proto__", "constructor", "prototype"].includes(k),
            ),
          ) as Record<string, Permission>;
      } else if (typeof value === typeof base.data[key])
        (base.data as any)[key] = value;
    }
    if (base.data.kind === "plugin")
      base.data.pluginConfig = parseInvocation(
        node.data.pluginConfig,
        base.data.plugin,
      );
    if (base.data.kind === "start" && !base.data.actions.includes("提交"))
      base.data.actions = ["提交", "保存草稿", "暂存"];
    base.data.briefFields = base.data.briefFields.filter(
      (id) =>
        base.data.permissions[id] && base.data.permissions[id] !== "hidden",
    );
    return base;
  });
  const edgeIds = new Set<string>();
  const edges = raw.edges.map((edge: any) => {
    if (
      !ids.has(edge.source) ||
      !ids.has(edge.target) ||
      typeof edge.id !== "string" ||
      edgeIds.has(edge.id)
    )
      throw new Error("连线引用了不存在的节点或存在重复 ID");
    edgeIds.add(edge.id);
    return makeEdge(edge.source, edge.target, {
      id: edge.id,
      sourceHandle: ["bottom", "left", "right"].includes(edge.sourceHandle)
        ? edge.sourceHandle
        : "bottom",
      targetHandle: "top",
      label: typeof edge.label === "string" ? edge.label : undefined,
    });
  });
  const defaults = initialDocument();
  const settings = raw.settings || {};
  const withdrawRule = ["none", "start", "all"].includes(settings.withdrawRule)
    ? settings.withdrawRule
    : settings.allowWithdraw === true
      ? "start"
      : "none";
  const autoSubmitRule = ["off", "previous", "handled"].includes(
    settings.autoSubmitRule,
  )
    ? settings.autoSubmitRule
    : settings.deduplicate === true
      ? "handled"
      : "off";
  const reminderChannels = Array.isArray(settings.reminderChannels)
    ? ["app", "wechat", "email"].filter((channel) =>
        settings.reminderChannels.includes(channel),
      )
    : settings.notify === true
      ? ["app"]
      : [];
  return {
    ...defaults,
    title: raw.title,
    description: typeof raw.description === "string" ? raw.description : "",
    enabled: raw.enabled === true,
    version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    ...(Array.isArray(raw.formFields)
      ? {
          formFields: raw.formFields
            .filter(
              (f: any) =>
                typeof f?.id === "string" && typeof f?.label === "string",
            )
            .map((f: any) => ({ id: f.id, label: f.label })),
        }
      : {}),
    settings: {
      ...defaults.settings,
      allowWithdraw: withdrawRule !== "none",
      notify: reminderChannels.length > 0,
      deduplicate: autoSubmitRule !== "off",
      reminderChannels,
      withdrawRule,
      autoSubmitRule,
      viewProgress:
        typeof settings.viewProgress === "boolean"
          ? settings.viewProgress
          : true,
      allowUrge: settings.allowUrge === true,
    },
    nodes,
    edges,
  };
}
export function nextFlowEdge(
  doc: FlowDocument,
  node: FlowNode,
  values: number | Record<string, unknown>,
) {
  const next = doc.edges.filter((e) => e.source === node.id);
  let edge = next[0];
  if (node.data.kind === "condition" && next.length > 1) {
    const match = node.data.condition.match(
      /^申请金额\s*(>=|<=|>|<|==)\s*(\d+(?:\.\d+)?)$/,
    );
    const fieldId =
      node.data.conditionFieldId ||
      doc.formFields?.find((f) => f.label === "申请金额")?.id ||
      "amount";
    const amount =
      typeof values === "number" ? values : Number(values[fieldId] ?? 0);
    const threshold = Number(match?.[2]),
      op = match?.[1];
    const pass =
      op === ">"
        ? amount > threshold
        : op === "<"
          ? amount < threshold
          : op === ">="
            ? amount >= threshold
            : op === "<="
              ? amount <= threshold
              : amount === threshold;
    edge = pass ? next[0] : next[1];
  }
  return edge;
}
export function simulationPath(
  doc: FlowDocument,
  values: number | Record<string, unknown>,
): FlowNode[] {
  const path: FlowNode[] = [],
    visited = new Set<string>();
  let node = doc.nodes.find((n) => n.data.kind === "start");
  while (node && !visited.has(node.id)) {
    path.push(node);
    visited.add(node.id);
    const edge = nextFlowEdge(doc, node, values);
    node = doc.nodes.find((n) => n.id === edge?.target);
  }
  return path;
}

export interface WorkflowFragment {
  nodes: FlowNode[];
  edges: Edge[];
}
/** Copy a graph fragment, excluding the unique start/end nodes. */
export function copyFragment(
  doc: FlowDocument,
  nodeIds: string[],
  edgeId?: string | null,
): WorkflowFragment {
  const ids = new Set(nodeIds);
  if (edgeId) {
    const edge = doc.edges.find((e) => e.id === edgeId);
    if (edge) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
  }
  const nodes = doc.nodes.filter(
    (n) => ids.has(n.id) && !["start", "end"].includes(n.data.kind),
  );
  const included = new Set(nodes.map((n) => n.id));
  return clone({
    nodes,
    edges: doc.edges.filter(
      (e) => included.has(e.source) && included.has(e.target),
    ),
  });
}
export function pasteFragment(
  doc: FlowDocument,
  fragment: WorkflowFragment,
  offset = 44,
): string[] {
  const idMap = new Map<string, string>();
  let next = Math.max(0, ...doc.nodes.map((n) => Number(n.id) || 0)) + 1;
  const nodes = fragment.nodes
    .filter((n) => !["start", "end"].includes(n.data.kind))
    .map((n) => {
      const id = String(next++);
      idMap.set(n.id, id);
      const node = makeNode(
        id,
        n.data.kind,
        n.position.x + offset,
        n.position.y + offset,
      );
      node.data = clone(n.data);
      node.data.label = `${node.data.label.slice(0, 36)} 副本`;
      return node;
    });
  doc.nodes.push(...nodes);
  for (const edge of fragment.edges) {
    const source = idMap.get(edge.source),
      target = idMap.get(edge.target);
    if (source && target)
      doc.edges.push(
        makeEdge(source, target, {
          label: edge.label,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
        }),
      );
  }
  return nodes.map((n) => n.id);
}
