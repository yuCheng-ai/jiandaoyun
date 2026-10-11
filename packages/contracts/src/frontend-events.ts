import type { DataFilter, FormSchema } from "./form";

export interface ValueBinding {
  source: "constant" | "field" | "template";
  value: string;
}
export interface PluginInvocation {
  actionId: string;
  inputs: Record<string, ValueBinding>;
  outputs: { outputKey: string; fieldId: string }[];
}
export interface FrontendRequest {
  method: "GET" | "POST";
  url: ValueBinding;
  headers: { name: string; value: ValueBinding }[];
  bodyFormat: "json" | "form";
  body: { name: string; value: ValueBinding }[];
  responseFormat: "json" | "xml";
  outputs: { fieldId: string; path: ValueBinding }[];
  subformFill: "merge" | "replace";
  /** Frontend-only adapter data. Never treated as a verified server response. */
  simulation: { status: number; response: string };
}
export interface FrontendDataSelection {
  formId: string;
  columns: string[];
  columnLabels?: Record<string, string>;
  filters: DataFilter[];
  match: "all" | "any";
  sort: { fieldId: string; direction: "asc" | "desc" };
  mappings: { sourceFieldId: string; targetFieldId: string }[];
  subformFill: "merge" | "replace";
}
interface FrontendEventBase {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: "field" | "submit";
  fieldIds: string[];
}
export type FrontendEvent = FrontendEventBase &
  (
    | { plugin: PluginInvocation; request?: never; selection?: never }
    | { request: FrontendRequest; plugin?: never; selection?: never }
    | { selection: FrontendDataSelection; request?: never; plugin?: never }
  );
export interface FrontendFieldChange {
  fieldId: string;
  row?: { subformId: string; index: number };
}

/** Optional chooser labels never change the identity or name of a source field. */
export function validSelectionColumnLabels(
  labels: unknown,
  columns: string[],
): labels is Record<string, string> | undefined {
  return (
    labels === undefined ||
    (!!labels &&
      typeof labels === "object" &&
      !Array.isArray(labels) &&
      Object.keys(labels).length <= 100 &&
      Object.entries(labels).every(
        ([id, label]) =>
          /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(id) &&
          !["constructor", "prototype", "__proto__"].includes(id) &&
          columns.includes(id) &&
          typeof label === "string" &&
          !!label.trim() &&
          label.length <= 100,
      ))
  );
}

/** Validate stored configuration without deleting references to removed fields. */
export function frontendEventSettingsErrors(
  settings: FormSchema["settings"],
): string[] {
  const events = settings.frontendEvents;
  if (events === undefined) return [];
  const object = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const id = (v: unknown): v is string =>
    typeof v === "string" &&
    /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(v) &&
    !["constructor", "prototype", "__proto__"].includes(v);
  const keys = (v: Record<string, any>, allowed: string[]) =>
    Object.keys(v).every((key) => allowed.includes(key));
  const seen = new Set<string>();
  const binding = (v: unknown) =>
    object(v) &&
    keys(v, ["source", "value"]) &&
    ["constant", "field", "template"].includes(v.source) &&
    typeof v.value === "string" &&
    v.value.length <= 10000;
  if (!Array.isArray(events) || events.length > 100)
    return ["前端事件最多配置100个"];
  if (events.filter((event) => event?.trigger === "submit").length > 1)
    return ["每张表单只能配置一个提交触发事件"];
  for (const event of events) {
    if (
      !object(event) ||
      !keys(event, [
        "id",
        "name",
        "description",
        "enabled",
        "trigger",
        "fieldIds",
        "plugin",
        "request",
        "selection",
      ]) ||
      !id(event.id) ||
      seen.has(event.id) ||
      typeof event.name !== "string" ||
      !event.name.trim() ||
      event.name.length > 100 ||
      typeof event.description !== "string" ||
      event.description.length > 1000 ||
      typeof event.enabled !== "boolean" ||
      !["field", "submit"].includes(event.trigger) ||
      !Array.isArray(event.fieldIds) ||
      event.fieldIds.length > 100 ||
      event.fieldIds.some((value) => !id(value)) ||
      new Set(event.fieldIds).size !== event.fieldIds.length ||
      (event.trigger === "submit" && event.fieldIds.length)
    )
      return ["前端事件配置不合法，请保留原配置并检查事件"];
    seen.add(event.id);
    if (event.selection !== undefined) {
      const selection = event.selection;
      if (
        event.plugin !== undefined ||
        event.request !== undefined ||
        !object(selection) ||
        !keys(selection, [
          "formId",
          "columns",
          "columnLabels",
          "filters",
          "match",
          "sort",
          "mappings",
          "subformFill",
        ]) ||
        !id(selection.formId) ||
        !Array.isArray(selection.columns) ||
        selection.columns.length > 100 ||
        selection.columns.some((value: unknown) => !id(value)) ||
        new Set(selection.columns).size !== selection.columns.length ||
        !validSelectionColumnLabels(
          selection.columnLabels,
          selection.columns,
        ) ||
        !["all", "any"].includes(selection.match) ||
        !["merge", "replace"].includes(selection.subformFill) ||
        !object(selection.sort) ||
        !keys(selection.sort, ["fieldId", "direction"]) ||
        !(
          selection.sort.fieldId === "$createdAt" || id(selection.sort.fieldId)
        ) ||
        !["asc", "desc"].includes(selection.sort.direction) ||
        !Array.isArray(selection.mappings) ||
        selection.mappings.length > 100 ||
        selection.mappings.some(
          (mapping: any) =>
            !object(mapping) ||
            !keys(mapping, ["sourceFieldId", "targetFieldId"]) ||
            !id(mapping.sourceFieldId) ||
            !id(mapping.targetFieldId),
        ) ||
        !Array.isArray(selection.filters) ||
        selection.filters.length > 100 ||
        selection.filters.some(
          (filter: any) =>
            !object(filter) ||
            !keys(filter, [
              "id",
              "sourceFieldId",
              "operator",
              "source",
              "value",
            ]) ||
            !id(filter.id) ||
            !id(filter.sourceFieldId) ||
            ![
              "equals",
              "notEquals",
              "contains",
              "greater",
              "less",
              "notEmpty",
            ].includes(filter.operator) ||
            !["constant", "field", "currentUser", "currentDepartment"].includes(
              filter.source,
            ) ||
            typeof filter.value !== "string" ||
            filter.value.length > 10000 ||
            (filter.source === "field" &&
              filter.operator !== "notEmpty" &&
              !id(filter.value)),
        ) ||
        new Set(selection.filters.map((filter: any) => filter.id)).size !==
          selection.filters.length
      )
        return ["前端事件选数配置不合法"];
      continue;
    }
    if (event.request !== undefined) {
      const request = event.request;
      if (
        event.plugin !== undefined ||
        event.selection !== undefined ||
        !object(request) ||
        !keys(request, [
          "method",
          "url",
          "headers",
          "bodyFormat",
          "body",
          "responseFormat",
          "outputs",
          "subformFill",
          "simulation",
        ]) ||
        !["GET", "POST"].includes(request.method) ||
        !binding(request.url) ||
        !["json", "form"].includes(request.bodyFormat) ||
        !["json", "xml"].includes(request.responseFormat) ||
        !["merge", "replace"].includes(request.subformFill) ||
        !object(request.simulation) ||
        !keys(request.simulation, ["status", "response"]) ||
        !Number.isInteger(request.simulation.status) ||
        request.simulation.status < 100 ||
        request.simulation.status > 599 ||
        typeof request.simulation.response !== "string" ||
        request.simulation.response.length > 262144 ||
        !Array.isArray(request.outputs) ||
        request.outputs.length > 100 ||
        request.outputs.some(
          (m: any) =>
            !object(m) ||
            !keys(m, ["fieldId", "path"]) ||
            !id(m.fieldId) ||
            !binding(m.path),
        ) ||
        [request.headers, request.body].some(
          (rows) =>
            !Array.isArray(rows) ||
            rows.length > 50 ||
            rows.some(
              (row: any) =>
                !object(row) ||
                !keys(row, ["name", "value"]) ||
                typeof row.name !== "string" ||
                row.name.length > 100 ||
                !binding(row.value),
            ),
        )
      )
        return ["前端事件请求配置不合法"];
      continue;
    }
    const plugin = event.plugin;
    if (
      !object(plugin) ||
      !keys(plugin, ["actionId", "inputs", "outputs"]) ||
      !id(plugin.actionId) ||
      !object(plugin.inputs) ||
      Object.keys(plugin.inputs).length > 50 ||
      !Array.isArray(plugin.outputs) ||
      plugin.outputs.length > 100
    )
      return ["前端事件动作配置不合法"];
    if (
      Object.entries(plugin.inputs).some(
        ([key, binding]) =>
          !id(key) ||
          !object(binding) ||
          !keys(binding, ["source", "value"]) ||
          !["constant", "field", "template"].includes(binding.source) ||
          typeof binding.value !== "string" ||
          binding.value.length > 10000,
      ) ||
      plugin.outputs.some(
        (mapping) =>
          !object(mapping) ||
          !keys(mapping, ["outputKey", "fieldId"]) ||
          !id(mapping.outputKey) ||
          !id(mapping.fieldId),
      )
    )
      return ["前端事件参数或回填配置不合法"];
  }
  return [];
}
