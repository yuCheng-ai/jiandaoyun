import {
  ocrTemplate,
  type OcrContent,
  type OcrSettings,
  type OcrType,
} from "@platform/contracts";
import {
  copy,
  createField,
  findField,
  findFieldContainer,
  flattenFields,
  parseSchema,
  isFieldVisibleInSchema,
  resolveCalculations,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { frontendValueFields, mapFrontendValues } from "./frontendEventValues";
import { applyFieldChange, scopeFields } from "./relations";
import type { WorkspaceData } from "./workspace";

export function ocrTargets(schema: FormSchema, content: OcrContent) {
  return frontendValueFields(schema).filter(
    (field) =>
      content.types.includes(field.type) && (!field.parentId || content.detail),
  );
}
export function ocrConfigurationErrors(
  field: FormField,
  schema: FormSchema,
): string[] {
  if (field.type !== "ocr" || !field.ocr) return [];
  const template = ocrTemplate(field.ocr.type);
  if (!template) return ["请选择识别内容"];
  if (!field.ocr.mappings.length) return ["请设置识别规则"];
  const errors: string[] = [];
  for (const mapping of field.ocr.mappings) {
    const content = template.contents.find(
      (item) => item.id === mapping.contentId,
    );
    if (
      !content ||
      !ocrTargets(schema, content).some(
        (target) => target.id === mapping.fieldId,
      )
    )
      errors.push("识别规则的字段已移除或类型不匹配");
  }
  if (
    new Set(field.ocr.mappings.map((item) => item.fieldId)).size !==
    field.ocr.mappings.length
  )
    errors.push("多个识别内容不能存到同一字段");
  return [...new Set(errors)];
}
export function matchOcrTargets(
  schema: FormSchema,
  type: OcrType,
  selected: string[],
) {
  const template = ocrTemplate(type)!;
  const used = new Set<string>();
  return selected.map((contentId) => {
    const content = template.contents.find((item) => item.id === contentId)!;
    if (!content) return { contentId, fieldId: "" };
    const matches = ocrTargets(schema, content).filter(
      (field) => field.label === content.label && !used.has(field.id),
    );
    const fieldId = matches.length === 1 ? matches[0]!.id : "";
    if (fieldId) used.add(fieldId);
    return { contentId, fieldId };
  });
}
/** One schema transaction creates all outputs and binds their stable IDs. */
export function configureOcr(
  schema: FormSchema,
  id: string,
  type: OcrType,
  selected: string[],
  mode: "new" | "existing",
  mappings: OcrSettings["mappings"] = [],
): FormSchema {
  const next = copy(schema),
    field = findField(next.fields, id),
    template = ocrTemplate(type);
  if (!field || field.type !== "ocr" || !template)
    throw Error("文字识别字段已变化，请重新打开设置");
  const container = findFieldContainer(next.fields, id)!;
  if (
    flattenFields(next.fields).some(
      (parent) => parent.type === "subform" && parent.children === container,
    )
  )
    throw Error("文字识别仅支持主表字段");
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some(
      (item) => !template.contents.some((content) => content.id === item),
    )
  )
    throw Error("请选择有效的识别内容");
  const contents = template.contents.filter((item) =>
    selected.includes(item.id),
  );
  let output: OcrSettings["mappings"];
  if (mode === "new") {
    const fields = contents.map((content) =>
      createField(content.defaultType, {
        label: content.label,
        ...(content.defaultType === "datetime"
          ? { format: "date", dateDefault: "custom" as const }
          : {}),
        ...(field.tabId ? { tabId: field.tabId } : {}),
      }),
    );
    container.splice(container.indexOf(field) + 1, 0, ...fields);
    output = contents.map((content, index) => ({
      contentId: content.id,
      fieldId: fields[index]!.id,
    }));
  } else {
    output = contents.map((content) => ({
      contentId: content.id,
      fieldId:
        mappings.find((item) => item.contentId === content.id)?.fieldId || "",
    }));
    if (output.some((item) => !item.fieldId))
      throw Error("请为每项识别内容选择存储字段");
  }
  field.ocr = { type, mappings: output };
  const errors = ocrConfigurationErrors(field, next);
  if (errors.length) throw Error(errors[0]);
  return parseSchema(next);
}

/** The service returns catalogue keys; targets always come from the published form definition. */
export function applyOcrResult(
  schema: FormSchema,
  fieldId: string,
  values: FormValues,
  result: Record<string, unknown>,
  data: WorkspaceData,
): FormValues {
  const field = frontendValueFields(schema, true).find(
    (item) => item.id === fieldId,
  );
  if (
    !field?.ocr ||
    !field.visible ||
    !field.editable ||
    !isFieldVisibleInSchema(field, schema, values)
  )
    throw Error("当前文字识别不可编辑，未回填任何字段");
  const issues = ocrConfigurationErrors(field, schema);
  if (issues.length) throw Error(issues[0]);
  const contents = ocrTemplate(field.ocr.type)!.contents;
  const fields = frontendValueFields(schema);
  const mappings = field.ocr.mappings
    .filter(
      (mapping) =>
        Object.hasOwn(result, mapping.contentId) &&
        result[mapping.contentId] !== null &&
        result[mapping.contentId] !== undefined &&
        result[mapping.contentId] !== "" &&
        (!Array.isArray(result[mapping.contentId]) ||
          (result[mapping.contentId] as unknown[]).length > 0),
    )
    .map((mapping) => {
      const content = contents.find((item) => item.id === mapping.contentId)!;
      const target = fields.find((item) => item.id === mapping.fieldId)!;
      let value = result[mapping.contentId];
      if (content.detail && Array.isArray(value)) {
        value = value.slice(0, 200);
        if (!target.parentId) {
          if (["text", "textarea"].includes(target.type))
            value = (value as unknown[]).join("、");
          else if ((value as unknown[]).length === 1)
            value = (value as unknown[])[0];
          else throw Error(`${target.label}：多条识别明细请存到子表列`);
        }
      }
      if (target.type === "number") {
        const digits = target.precision ?? 2;
        const round = (input: unknown) =>
          (typeof input === "number" || typeof input === "string") &&
          Number.isFinite(Number(input)) &&
          String(input).trim()
            ? Number(Number(input).toFixed(digits))
            : input;
        value = Array.isArray(value) ? value.map(round) : round(value);
      }
      return { fieldId: target.id, value };
    });
  if (!mappings.length)
    throw Error("未识别到已配置的内容，请换一张清晰图片重试");
  const mapped = mapFrontendValues(
    schema,
    values,
    data,
    fields,
    mappings,
    "merge",
  );
  let next = copy(values);
  for (const [id, value] of Object.entries(mapped))
    next = applyFieldChange(schema.fields, next, id, value, data);
  // Preserve readonly/hidden values changed indirectly by another mapped field.
  for (const target of scopeFields(schema.fields)) {
    if (
      target.type === "calculated" ||
      (target.visible &&
        target.editable &&
        isFieldVisibleInSchema(target, schema, next))
    )
      continue;
    if (Object.hasOwn(values, target.id))
      next[target.id] = copy(values[target.id]);
    else delete next[target.id];
  }
  next = resolveCalculations(schema.fields, next);
  for (const mapping of mappings) {
    const target = fields.find((item) => item.id === mapping.fieldId)!;
    if (
      !target.parentId &&
      JSON.stringify(next[target.id]) !== JSON.stringify(mapped[target.id])
    )
      throw Error("识别结果与当前权限或联动条件冲突，未回填任何字段");
  }
  return next;
}
