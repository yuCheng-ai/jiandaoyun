import { hasFieldValue } from "@platform/contracts";
import {
  copy,
  uid,
  isFieldVisible,
  validateValues,
  resolveCalculations,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { parseFilters, type DataFilter } from "./fieldConfig";
import {
  applyFieldChange,
  displayValue,
  matchesFilters,
  runtimeDefaults,
  scopeFields,
  resolveChoices,
  idsOf,
} from "./relations";
import { validateDynamicValues } from "./fieldValidation";
import type { WorkspaceData } from "./workspace";
import type { ConfigIssue } from "./extensions";

export const buttonPositions = {
  fill: "填写页",
  detail: "数据详情",
  row: "列表行",
} as const;
export const buttonActions = {
  update: "更新字段",
  openForm: "打开表单并带入数据",
  link: "打开链接",
} as const;
export type ButtonPosition = keyof typeof buttonPositions;
export interface ButtonBinding {
  source: "constant" | "field";
  fieldId: string;
  value: unknown;
}
export interface ButtonMapping extends ButtonBinding {
  targetId: string;
}
export interface CustomButton {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  positions: ButtonPosition[];
  primary: boolean;
  filters: DataFilter[];
  action: keyof typeof buttonActions;
  url: string;
  params: { name: string; binding: ButtonBinding }[];
  targetFormId: string;
  mappings: ButtonMapping[];
  confirmation: string;
}
export function newButton(): CustomButton {
  return {
    id: uid("button"),
    name: "",
    enabled: true,
    archived: false,
    positions: ["fill"],
    primary: false,
    filters: [],
    action: "update",
    url: "",
    params: [],
    targetFormId: "",
    mappings: [],
    confirmation: "",
  };
}
const safeId = (s: string) =>
  !!s && !["__proto__", "constructor", "prototype"].includes(s);
export function parseButtons(raw: any): CustomButton[] {
  const seen = new Set<string>();
  const binding = (b: any): ButtonBinding => ({
    source: b?.source === "field" ? "field" : "constant",
    fieldId: String(b?.fieldId || ""),
    value: copy(b?.value ?? ""),
  });
  return (Array.isArray(raw) ? raw : []).slice(0, 50).map((c: any) => {
    if (!c || typeof c.id !== "string" || !safeId(c.id) || seen.has(c.id))
      throw Error("自定义按钮 ID 无效或重复");
    seen.add(c.id);
    return {
      ...newButton(),
      id: c.id,
      name: String(c.name || ""),
      enabled: c.enabled === true,
      archived: c.archived === true,
      primary: c.primary === true,
      positions: [
        ...new Set<string>(Array.isArray(c.positions) ? c.positions : []),
      ].filter((p): p is ButtonPosition => Object.hasOwn(buttonPositions, p)),
      filters: parseFilters(c.filters),
      action: Object.hasOwn(buttonActions, c.action) ? c.action : "update",
      url: String(c.url || ""),
      targetFormId: String(c.targetFormId || ""),
      confirmation: String(c.confirmation || ""),
      params: (Array.isArray(c.params) ? c.params : [])
        .slice(0, 30)
        .map((p: any) => ({
          name: String(p?.name || ""),
          binding: binding(p?.binding),
        })),
      mappings: (Array.isArray(c.mappings) ? c.mappings : [])
        .slice(0, 100)
        .map((m: any) => ({
          ...binding(m),
          targetId: String(m?.targetId || ""),
        })),
    };
  });
}
const writableTypes = [
  "text",
  "textarea",
  "number",
  "datetime",
  "radio",
  "checkbox",
  "select",
  "multiselect",
  "member",
  "members",
  "department",
  "departments",
  "phone",
  "email",
  "url",
];
export function buttonTargets(schema: FormSchema): FormField[] {
  function visit(fields: FormField[]): FormField[] {
    return fields.flatMap((f) =>
      !f.editable || !f.visible
        ? []
        : f.type === "tabs"
          ? visit(f.children)
          : writableTypes.includes(f.type)
            ? [f]
            : [],
    );
  }
  return visit(schema.fields);
}
export function buttonSources(schema: FormSchema) {
  return scopeFields(schema.fields).filter(hasFieldValue);
}
export function buttonReferences(c: CustomButton): string[] {
  const bindings =
    c.action === "link" ? c.params.map((p) => p.binding) : c.mappings;
  return [
    ...c.filters.flatMap((f) => [
      f.sourceFieldId,
      ...(f.source === "field" ? [f.value] : []),
    ]),
    ...bindings.filter((b) => b.source === "field").map((b) => b.fieldId),
    ...(c.action === "update" ? c.mappings.map((m) => m.targetId) : []),
  ];
}
export function buttonIssues(
  c: CustomButton,
  schema: FormSchema,
  data?: WorkspaceData,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [],
    fail = (step: number, target: string, message: string) =>
      issues.push({ step, target, message });
  const ids = new Set(buttonSources(schema).map((f) => f.id));
  if (!c.name.trim()) fail(0, "name", "请填写按钮名称");
  if (c.params.length > 30 || c.mappings.length > 100)
    fail(1, "mappings", "最多配置 30 个链接参数或 100 个字段映射");
  if (!c.positions.length) fail(0, "positions", "至少选择一个显示位置");
  for (const f of c.filters)
    if (
      !ids.has(f.sourceFieldId) ||
      (f.source === "field" && !ids.has(f.value))
    )
      fail(0, "filters", "显示条件引用的字段已失效");
  const bindings =
    c.action === "link" ? c.params.map((p) => p.binding) : c.mappings;
  if (bindings.some((b) => b.source === "field" && !ids.has(b.fieldId)))
    fail(1, "mappings", "请选择有效的来源字段");
  if (c.action === "link") {
    try {
      const url = new URL(c.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error();
    } catch {
      fail(1, "url", "请填写不含账号密码的完整 HTTP 或 HTTPS 地址");
    }
    const names = c.params.map((p) => p.name.trim());
    if (names.some((n) => !n) || new Set(names).size !== names.length)
      fail(1, "params", "链接参数名称不能为空或重复");
  } else {
    const target =
      c.action === "update"
        ? schema
        : data?.forms.find((f) => f.id === c.targetFormId && !f.archived)
            ?.published?.schema;
    if (c.action === "openForm" && (!c.targetFormId || (data && !target)))
      fail(1, "target", "请选择已发布且未归档的目标表单");
    if (c.action === "update" && !c.mappings.length)
      fail(1, "mappings", "至少设置一个更新字段");
    const targetIds = new Set(
        target ? buttonTargets(target).map((f) => f.id) : [],
      ),
      used = new Set<string>();
    for (const m of c.mappings) {
      if (
        !safeId(m.targetId) ||
        used.has(m.targetId) ||
        (target && !targetIds.has(m.targetId))
      )
        fail(1, "mappings", "目标字段不可写、已失效或被重复设置");
      used.add(m.targetId);
    }
  }
  return issues;
}
export interface ButtonResult {
  status: "ready" | "hidden" | "error";
  message: string;
  url?: string;
  targetFormId?: string;
  targetTitle?: string;
  appId?: string;
  version?: number;
  values?: FormValues;
  changes: { id: string; label: string; before: string; after: string }[];
}
function typedValue(
  target: FormField,
  value: unknown,
  source: FormField | undefined,
  sourceValues: FormValues,
  next: FormValues,
  data: WorkspaceData,
  sourceFields: FormField[],
  targetFields: FormField[],
): unknown {
  if (value == null || value === "" || (Array.isArray(value) && !value.length))
    return ["members", "departments", "checkbox", "multiselect"].includes(
      target.type,
    )
      ? []
      : "";
  if (target.type === "number") {
    if (typeof value !== "string" && typeof value !== "number")
      throw Error(`「${target.label}」需要数字`);
    const n = Number(value);
    if (!Number.isFinite(n)) throw Error(`「${target.label}」需要有效数字`);
    return n;
  }
  if (["radio", "select", "checkbox", "multiselect"].includes(target.type)) {
    const choices = resolveChoices(target, data, next, targetFields);
    const sourceChoices =
      source &&
      ["radio", "select", "checkbox", "multiselect"].includes(source.type)
        ? resolveChoices(source, data, sourceValues, sourceFields)
        : [];
    const selected = idsOf(value).map((id) => {
      const label = sourceChoices.find((o) => o.id === id)?.label;
      const matches = choices.filter(
        (o) => o.id === id || (label !== undefined && o.label === label),
      );
      if (matches.length !== 1)
        throw Error(`「${target.label}」的选项不存在或名称不唯一`);
      return matches[0]!.id;
    });
    if (["radio", "select"].includes(target.type) && selected.length > 1)
      throw Error(`「${target.label}」只能带入一个选项`);
    return ["radio", "select"].includes(target.type)
      ? selected[0] || ""
      : selected;
  }
  if (
    ["member", "members", "department", "departments"].includes(target.type)
  ) {
    const ids = idsOf(value);
    if (["member", "department"].includes(target.type) && ids.length > 1)
      throw Error(`「${target.label}」只能带入一个值`);
    return ["member", "department"].includes(target.type) ? ids[0] || "" : ids;
  }
  if (target.type === "datetime") {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value) ||
      !Number.isFinite(new Date(value).getTime())
    )
      throw Error(`「${target.label}」需要有效日期`);
    return target.format === "date" ? value.slice(0, 10) : value;
  }
  if (source) return displayValue(source, value, data);
  if (typeof value === "object") throw Error(`「${target.label}」需要文本`);
  return String(value);
}
export function prepareButton(
  c: CustomButton,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  position: ButtonPosition,
  trial = false,
): ButtonResult {
  const fail = (message: string): ButtonResult => ({
    status: "error",
    message,
    changes: [],
  });
  const issues = buttonIssues(c, schema, data);
  if (issues.length) return fail(issues[0]!.message);
  if (
    (!trial && (!c.enabled || c.archived)) ||
    !c.positions.includes(position) ||
    !matchesFilters(c.filters, values, values, data, "all", scopeFields(schema.fields))
  )
    return {
      status: "hidden",
      message: "当前数据不满足按钮显示条件",
      changes: [],
    };
  const sources = buttonSources(schema);
  const read = (b: ButtonBinding) =>
    b.source === "field" ? values[b.fieldId] : b.value;
  if (c.action === "link") {
    const url = new URL(c.url);
    for (const p of c.params) {
      const f = sources.find((f) => f.id === p.binding.fieldId),
        v = read(p.binding);
      url.searchParams.set(
        p.name.trim(),
        v == null || v === ""
          ? ""
          : p.binding.source === "field" && f
            ? displayValue(f, v, data)
            : String(v),
      );
    }
    return {
      status: "ready",
      message: "将在新窗口打开以下链接",
      url: url.href,
      changes: [],
    };
  }
  const target =
    c.action === "openForm"
      ? data.forms.find((f) => f.id === c.targetFormId && !f.archived)
      : undefined;
  const destination = target?.published?.schema || schema;
  const original =
    c.action === "update"
      ? copy(values)
      : runtimeDefaults(destination.fields, data);
  const result = mapFieldValues(
    c.mappings,
    schema,
    values,
    destination,
    original,
    data,
  );
  if (result.status !== "ready") return result;
  return {
    ...result,
    message:
      c.action === "update"
        ? "确认以下变更后应用"
        : "带入目标表单后，请检查并提交",
    targetFormId: target?.id,
    targetTitle: target?.published?.title,
    appId: target?.appId,
    version: target?.published?.version,
  };
}

/** Shared typed field mapping for buttons and local automation. Never mutates input records. */
export function mapFieldValues(
  mappings: ButtonMapping[],
  sourceSchema: FormSchema,
  sourceValues: FormValues,
  destination: FormSchema,
  original: FormValues,
  data: WorkspaceData,
): ButtonResult {
  const fail = (message: string): ButtonResult => ({
    status: "error",
    message,
    changes: [],
  });
  const sources = buttonSources(sourceSchema);
  const read = (b: ButtonBinding) =>
    b.source === "field" ? sourceValues[b.fieldId] : b.value;
  let next = copy(original);
  const fields = buttonTargets(destination),
    mapped = new Map<string, unknown>();
  // Resolve all source bindings against the same source snapshot, then apply dependencies.
  for (const m of mappings) next[m.targetId] = copy(read(m) ?? "");
  try {
    for (const m of mappings) {
      const field = fields.find((f) => f.id === m.targetId)!;
      const value = typedValue(
        field,
        read(m),
        m.source === "field"
          ? sources.find((f) => f.id === m.fieldId)
          : undefined,
        sourceValues,
        next,
        data,
        sourceSchema.fields,
        destination.fields,
      );
      next[m.targetId] = value;
      mapped.set(m.targetId, value);
    }
    for (const m of mappings)
      next = applyFieldChange(
        destination.fields,
        next,
        m.targetId,
        next[m.targetId],
        data,
      );
  } catch (error) {
    return fail(error instanceof Error ? error.message : "字段值无法带入");
  }
  function writable(id: string, list = destination.fields): boolean {
    return list.some(
      (f) =>
        (f.id === id || (f.type === "tabs" && writable(id, f.children))) &&
        f.editable &&
        isFieldVisible(f, destination, next),
    );
  }
  for (const [id, value] of mapped) {
    if (!writable(id))
      return fail(
        `「${fields.find((f) => f.id === id)?.label}」当前不可编辑或不可见`,
      );
    if (JSON.stringify(next[id]) !== JSON.stringify(value))
      return fail(
        `「${fields.find((f) => f.id === id)?.label}」与当前联动条件不匹配`,
      );
  }
  next = resolveCalculations(destination.fields, next);
  const changedIds = new Set(
    Object.keys(next).filter(
      (id) => JSON.stringify(next[id]) !== JSON.stringify(original[id]),
    ),
  );
  const partial = copy(destination);
  function optional(list: FormField[]) {
    list.forEach((f) => {
      f.required = false;
      optional(f.children);
    });
  }
  optional(partial.fields);
  const errors = [
    ...validateValues(partial, next),
    ...validateDynamicValues(partial, next, data),
  ].filter((e) => changedIds.has(e.fieldId) || mapped.has(e.fieldId));
  if (errors.length) return fail(errors[0]!.message);
  return {
    status: "ready",
    message: "字段映射已检查",
    values: next,
    changes: buttonSources(destination)
      .filter((f) => changedIds.has(f.id))
      .map((f) => ({
        id: f.id,
        label: f.label,
        before: displayValue(f, original[f.id], data),
        after: displayValue(f, next[f.id], data),
      })),
  };
}
