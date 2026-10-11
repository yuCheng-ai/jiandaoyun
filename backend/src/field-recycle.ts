import { BadRequestException } from "@nestjs/common";
import {
  defaultPageSettings,
  separateFormSchema,
  validateVisibilityRules,
  formulaTypes,
  formulaSyntaxError,
  type FormSchema,
  type RecycledField,
} from "@platform/contracts";
import { allFields, identifier, object } from "./schema";
import { parseModel, parsePage } from "./page-schema";

/** Validate recoverable design fields with the same supported field contract. */
export function parseFieldTrash(
  raw: unknown,
  activeIds: Iterable<string> = [],
): RecycledField[] {
  if (!Array.isArray(raw))
    throw new BadRequestException("字段回收站格式不合法");
  const ids = new Set(activeIds);
  return raw.map((item) => {
    object(item);
    if (
      Object.keys(item).some(
        (key) => !["field", "parentId", "rules"].includes(key),
      ) ||
      !Array.isArray(item.rules)
    )
      throw new BadRequestException("字段回收配置包含不支持的内容");
    if (item.parentId !== null) identifier(item.parentId);
    try {
      validateVisibilityRules(item.rules, [], false);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const schema: FormSchema = {
      version: 1,
      fields: [item.field],
      settings: defaultPageSettings(),
    };
    try {
      const validationSchema = structuredClone(schema);
      // Archived formulas may refer to fields that are temporarily absent. Preserve the
      // original expression; restoration rechecks it against the complete active schema.
      for (const field of allFields(validationSchema)) if (field.defaultFormula === true) {
        if (!formulaTypes.includes(field.type) || typeof field.expression !== "string")
          throw new BadRequestException("回收字段的公式配置不合法");
        const issue = field.expression.trim() && formulaSyntaxError(field.expression);
        if (issue) throw new BadRequestException(issue);
        field.defaultFormula = false; field.expression = "";
      }
      const separated = separateFormSchema(validationSchema);
      parsePage(separated.page, parseModel(separated.model, true), true);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('回收字段结构无效，请保留原配置后重新检查');
    }
    for (const field of allFields(schema)) {
      if (ids.has(field.id))
        throw new BadRequestException("回收字段与当前字段或其他回收字段重复");
      ids.add(field.id);
    }
    if (
      item.parentId &&
      (item.field.type === "subform" || item.field.id === item.parentId)
    )
      throw new BadRequestException("回收字段的原位置不合法");
    return structuredClone(item) as RecycledField;
  });
}
