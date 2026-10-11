import {
  copy,
  isFieldVisible,
  resolveCalculations,
  validateValues,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import {
  scopeFields,
  resolveChoices,
  relationCandidates,
  recordLabel,
  displayValue,
  applyFieldChange,
} from "./relations";
import { allowedEmployees, allowedDepartments } from "./organization";
import { validateDynamicValues } from "./fieldValidation";
import type { FormRecord, WorkspaceData } from "./workspace";
import { validDateValue, normalizeDateValue } from "@platform/contracts";

export interface QuickFillConfig {
  enabled: boolean;
  allowText: boolean;
  allowImages: boolean;
  example: string;
  fields: { fieldId: string; aliases: string[]; instruction: string }[];
}
export interface QuickFillAttachment {
  id?: string;
  name: string;
  size: number;
  type: string;
  preview: string;
}
export interface QuickFillSource {
  text: string;
  attachments: QuickFillAttachment[];
}
export interface QuickFillSuggestion {
  fieldId: string;
  raw: unknown;
  evidence: string;
  error?: string;
}
export interface QuickFillExtraction {
  mode: "local-demo";
  suggestions: QuickFillSuggestion[];
  unmatched: string[];
}
export const newQuickFill = (): QuickFillConfig => ({
  enabled: false,
  allowText: true,
  allowImages: false,
  example: "",
  fields: [],
});
export function parseQuickFill(raw: any): QuickFillConfig {
  return {
    enabled: raw?.enabled === true,
    allowText: raw?.allowText !== false,
    allowImages: raw?.allowImages === true,
    example: String(raw?.example || ""),
    fields: (Array.isArray(raw?.fields) ? raw.fields : []).map((f: any) => ({
      fieldId: String(f?.fieldId || ""),
      aliases: Array.isArray(f?.aliases)
        ? [
            ...new Set<string>(
              f.aliases
                .filter((a: unknown) => typeof a === "string")
                .map((a: string) => a.trim())
                .filter(Boolean),
            ),
          ]
        : [],
      instruction: String(f?.instruction || ""),
    })),
  };
}
const supported = [
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
  "relation",
  "image",
  "file",
];
export function quickFillFields(schema: FormSchema): FormField[] {
  const visit = (fields: FormField[]): FormField[] =>
    fields.flatMap((f) =>
      !f.visible || !f.editable
        ? []
        : f.type === "tabs"
          ? visit(f.children)
          : supported.includes(f.type)
            ? [f]
            : [],
    );
  return visit(schema.fields);
}
/** Parent tabs also participate in runtime visibility; subform rows have separate scopes. */
export function quickFillVisible(
  schema: FormSchema,
  id: string,
  values: FormValues,
): boolean {
  const visit = (fields: FormField[]): boolean =>
    fields.some(
      (f) =>
        isFieldVisible(f, schema, values) &&
        (f.id === id || (f.type === "tabs" && visit(f.children))),
    );
  return visit(schema.fields);
}
export function quickFillDesignSchema(
  form: Pick<FormRecord, "schema" | "kind" | "workflow">,
): FormSchema {
  const schema = copy(form.schema);
  if (form.kind === "workflow") {
    const permissions =
      form.workflow.nodes.find((n) => n.data.kind === "start")?.data
        .permissions || {};
    const visit = (fields: FormField[]) =>
      fields.forEach((f) => {
        if (permissions[f.id] === "hidden") f.visible = false;
        if (permissions[f.id] === "read") f.editable = false;
        visit(f.children);
      });
    visit(schema.fields);
  }
  return schema;
}
export function quickFillIssues(
  c: QuickFillConfig,
  schema: FormSchema,
): string[] {
  const errors: string[] = [],
    fields = quickFillFields(schema),
    seen = new Set<string>();
  if (!c.fields.length || c.fields.length > 30)
    errors.push("请选择 1–30 个可填写字段");
  if (!c.allowText && !c.allowImages) errors.push("至少启用一种输入方式");
  if (c.example.length > 10000) errors.push("填报示例不能超过 10,000 字");
  let complex = 0,
    uploads = 0;
  for (const item of c.fields) {
    const f = fields.find((f) => f.id === item.fieldId);
    if (!f || seen.has(item.fieldId))
      errors.push("填报字段已失效、不可编辑或重复");
    seen.add(item.fieldId);
    if (
      item.instruction.length > 1000 ||
      item.aliases.length > 10 ||
      item.aliases.some((a) => a.length > 80 || /[\n\r:：]/.test(a))
    )
      errors.push(
        "字段说明最多 1,000 字；别名最多 10 个，每个不超过 80 字且不能含冒号或换行",
      );
    if (
      f &&
      (["member", "members", "department", "departments", "relation"].includes(
        f.type,
      ) ||
        (["radio", "checkbox", "select", "multiselect"].includes(f.type) &&
          f.choiceSource.mode === "form"))
    )
      complex++;
    if (f && ["image", "file"].includes(f.type)) uploads++;
  }
  if (complex > 5) errors.push("人员、部门、关联及动态选项字段合计最多 5 个");
  if (uploads > 1) errors.push("图片或附件只能选择一个接收字段");
  if (c.allowImages && !uploads)
    errors.push("启用图片输入时，请选择一个图片或附件接收字段");
  return [...new Set(errors)];
}
export function quickFillCandidates(
  f: FormField,
  values: FormValues,
  data: WorkspaceData,
  inputFields: FormField[] = [],
) {
  if (["radio", "checkbox", "select", "multiselect"].includes(f.type))
    return resolveChoices(f, data, values, inputFields);
  if (["member", "members"].includes(f.type))
    return allowedEmployees(
      data.organization,
      f.organization.scope,
      values,
    ).map((e) => ({ id: e.id, label: e.name }));
  if (["department", "departments"].includes(f.type))
    return allowedDepartments(
      data.organization,
      f.organization.scope,
      values,
    ).map((d) => ({ id: d.id, label: d.name }));
  if (f.type === "relation")
    return relationCandidates(f, data, values, "", inputFields).map((e) => ({
      id: e.id,
      label: recordLabel(f, e, data),
    }));
  return undefined;
}
function validAttachment(file: QuickFillAttachment, field: FormField) {
  if (
    !file ||
    typeof file.name !== "string" ||
    !Number.isFinite(file.size) ||
    file.size <= 0 ||
    file.size > 5 * 1024 * 1024 ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    throw Error("仅支持 5 MB 以内的 PNG/JPEG/WebP/GIF 图片");
  const accepts = field.accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (
    accepts.length &&
    !accepts.some(
      (a) =>
        a === "*/*" ||
        a === file.type ||
        a === "image/*" ||
        (a.startsWith(".") && file.name.toLowerCase().endsWith(a)),
    )
  )
    throw Error("图片格式不符合目标字段限制");
  return {
    name: file.name.slice(0, 255),
    size: file.size,
    type: file.type,
    preview:
      file.size <= 300 * 1024 &&
      /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(
        file.preview,
      ) &&
      file.preview.length <= 420000
        ? file.preview
        : "",
  };
}
export function quickFillValue(
  f: FormField,
  raw: unknown,
  values: FormValues,
  data: WorkspaceData,
  inputFields: FormField[] = [],
): unknown {
  if (["file", "image"].includes(f.type)) {
    if (
      !Array.isArray(raw) ||
      !raw.length ||
      (!f.multiple && raw.length > 1) ||
      raw.length > 5
    )
      throw Error("图片数量不符合字段限制");
    return raw.map((r) => validAttachment(r, f));
  }
  const options = quickFillCandidates(f, values, data, inputFields);
  if (options) {
    const multiple = [
      "checkbox",
      "multiselect",
      "members",
      "departments",
    ].includes(f.type);
    const tokens = (
      Array.isArray(raw)
        ? raw.map(String)
        : String(raw ?? "").split(multiple ? /[,，、;；]/ : /\n/)
    )
      .map((s) => s.trim())
      .filter(Boolean);
    if (!tokens.length || (!multiple && tokens.length !== 1))
      throw Error("请选择有效的候选值");
    const ids = [
      ...new Set(
        tokens.map((s) => {
          const exactId = options.find((o) => o.id === s),
            matches = exactId
              ? [exactId]
              : options.filter((o) => o.label === s);
          if (matches.length !== 1)
            throw Error(
              matches.length
                ? `“${s}”有同名项，请手动选择`
                : `“${s}”不在当前可选范围内`,
            );
          return matches[0]!.id;
        }),
      ),
    ];
    return multiple ? ids : ids[0];
  }
  if (f.type === "number") {
    const text = String(raw ?? "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(text) || !Number.isFinite(Number(text)))
      throw Error("请输入有效数字，不包含单位");
    return Number(text);
  }
  if (typeof raw !== "string" && typeof raw !== "number")
    throw Error("需要文本内容");
  const value = String(raw).trim();
  if (f.type === "datetime") {
    if (!validDateValue(f.format, value))
      throw Error("请使用与字段类型一致的有效日期或时间");
    return normalizeDateValue(f.format, value);
  }
  return value;
}
export const quickFillEmpty = (value: unknown) =>
  value == null || value === "" || (Array.isArray(value) && !value.length);
export function normalizeQuickFill(
  extraction: QuickFillExtraction,
  config: QuickFillConfig,
  schema: FormSchema,
  baseline: FormValues,
  data: WorkspaceData,
) {
  const eligible = quickFillFields(schema).filter((f) =>
    config.fields.some((s) => s.fieldId === f.id),
  );
  const values = copy(baseline),
    errors: Record<string, string> = {},
    result: FormValues = {};
  // Resolve dependencies without relying on field order (e.g. a department before a scoped member).
  for (let pass = 0; pass <= eligible.length; pass++) {
    let changed = false;
    for (const item of extraction.suggestions) {
      const f = eligible.find((f) => f.id === item.fieldId);
      if (!f) continue;
      if (item.error) {
        errors[f.id] = item.error;
        continue;
      }
      try {
        const value = quickFillValue(f, item.raw, values, data, schema.fields);
        if (JSON.stringify(values[f.id]) !== JSON.stringify(value))
          changed = true;
        values[f.id] = value;
        result[f.id] = value;
        delete errors[f.id];
      } catch (e) {
        errors[f.id] = (e as Error).message;
        delete result[f.id];
        if (JSON.stringify(values[f.id]) !== JSON.stringify(baseline[f.id]))
          changed = true;
        if (Object.hasOwn(baseline, f.id)) values[f.id] = copy(baseline[f.id]);
        else delete values[f.id];
      }
    }
    if (!changed) break;
  }
  return { values: result, errors };
}
export function prepareQuickFill(
  config: QuickFillConfig,
  schema: FormSchema,
  baseline: FormValues,
  proposed: FormValues,
  selected: string[],
  data: WorkspaceData,
  formId: string,
) {
  const fields = quickFillFields(schema),
    ids = [...new Set(selected)];
  if (!config.enabled) throw Error("快捷填报已停用");
  if (!ids.length) throw Error("请至少选择一项需要回填的结果");
  const normalized = normalizeQuickFill(
    {
      mode: "local-demo",
      unmatched: [],
      suggestions: ids.map((id) => ({
        fieldId: id,
        raw: proposed[id],
        evidence: "",
      })),
    },
    config,
    schema,
    baseline,
    data,
  );
  const mapped = new Map<string, unknown>();
  for (const id of ids) {
    const f = fields.find((f) => f.id === id);
    if (!f || !config.fields.some((s) => s.fieldId === id))
      throw Error("选择了未配置或不可编辑的字段");
    if (normalized.errors[id])
      throw Error(`${f.label}：${normalized.errors[id]}`);
    mapped.set(id, normalized.values[id]);
  }
  let next = { ...copy(baseline), ...Object.fromEntries(mapped) };
  for (const [id, value] of mapped)
    next = applyFieldChange(schema.fields, next, id, value, data);
  // An indirect relation mapping must never widen the current runtime's write permissions.
  const scoped = scopeFields(schema.fields);
  for (const f of scoped)
    if (
      f.type !== "calculated" &&
      (!fields.some((e) => e.id === f.id) ||
        !quickFillVisible(schema, f.id, next))
    ) {
      if (Object.hasOwn(baseline, f.id)) next[f.id] = copy(baseline[f.id]);
      else delete next[f.id];
    }
  next = resolveCalculations(schema.fields, next);
  for (const [id, value] of mapped)
    if (
      !quickFillVisible(schema, id, next) ||
      JSON.stringify(next[id]) !== JSON.stringify(value)
    )
      throw Error("回填结果与当前字段权限或联动条件冲突，请调整选择");
  const changed = scoped.filter(
    (f) => JSON.stringify(next[f.id]) !== JSON.stringify(baseline[f.id]),
  );
  const partial = copy(schema);
  const optional = (items: FormField[]) =>
    items.forEach((f) => {
      if (!mapped.has(f.id)) f.required = false;
      optional(f.children);
    });
  optional(partial.fields);
  const errors = [
    ...validateValues(
      partial,
      next,
      data.entries
        .filter(
          (e) => e.formId === formId && !e.deletedAt && e.status !== "draft",
        )
        .map((e) => e.values),
    ),
    ...validateDynamicValues(partial, next, data),
  ].filter(
    (e) => changed.some((f) => f.id === e.fieldId) || mapped.has(e.fieldId),
  );
  if (errors.length) throw Error(errors[0]!.message);
  const changes = changed
    .filter((f) => quickFillVisible(schema, f.id, next))
    .map((f) => ({
      id: f.id,
      label: f.label,
      before: displayValue(f, baseline[f.id], data),
      after: displayValue(f, next[f.id], data),
      overwrite: !quickFillEmpty(baseline[f.id]),
      indirect: !mapped.has(f.id),
    }));
  return { values: next, changes };
}
