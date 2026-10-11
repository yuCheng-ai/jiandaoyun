import { BadRequestException, ConflictException } from "@nestjs/common";
import { composeFormSchema, modelFormSchema, separateFormSchema, pagePropertyKeys, defaultPageProperties, defaultPageSettings, dateRangeErrors, dateScopeFields, choiceSettingsErrors, type DataField, type DataFieldAddition, type DataModel, type FormPageSchema, type PageControl } from "@platform/contracts";
import { serverFieldTypes, serverDataKinds, fieldTextPropertiesErrors, validateVisibilityRules, validateFormValidations } from "@platform/contracts";
import { formLayoutErrors, externalStyleErrors, subformWidthErrors, subformPermissionSettingErrors, subformFixedColumnErrors, subformMobileErrors } from "@platform/contracts";
import { identifier, object, parseSchema } from "./schema";

export function parseModel(raw: unknown, allowIncomplete = false): DataModel {
  object(raw);
  if (raw.version !== 1 || !Array.isArray(raw.fields)) throw new BadRequestException("数据对象结构不合法");
  let count = 0;
  const visit = (field: unknown, nested: boolean): DataField => {
    object(field); object(field.settings); identifier(field.id);
    const textErrors = fieldTextPropertiesErrors({ type: "text", label: field.name });
    if (textErrors.length) throw new BadRequestException(textErrors[0]);
    if (++count > 120 || !serverDataKinds.includes(field.kind) || (nested && field.kind === "subform") || typeof field.required !== "boolean" || !Array.isArray(field.children)) throw new BadRequestException("数据字段类型或结构暂不支持");
    if (field.kind !== "subform" && field.children.length) throw new BadRequestException("普通字段不能包含明细列");
    return { id: field.id, name: field.name.trim(), kind: field.kind, required: field.required, settings: field.settings as DataField["settings"], children: field.children.map((child: unknown) => visit(child, true)) };
  };
  const model: DataModel = { version: 1, fields: raw.fields.map((field: unknown) => visit(field, false)) };
  for (const fields of [model.fields, ...model.fields.map(field => field.children)]) {
    const names = new Set<string>();
    for (const field of fields) {
      if (names.has(field.name)) throw new ConflictException(`同一范围已有「${field.name}」，请复用已有字段或为新字段更名`);
      names.add(field.name);
    }
  }
  // Reuse the actual server value validator; strip presentation and unknown properties.
  return separateFormSchema(parseSchema(modelFormSchema(model), allowIncomplete)).model;
}
export function modelWithAdditions(model: DataModel, raw: unknown, allowIncomplete = false): { model: DataModel; additions: DataFieldAddition[] } {
  if (!Array.isArray(raw) || raw.length > 60) throw new BadRequestException("新增字段列表不合法");
  const result = structuredClone(model), additions: DataFieldAddition[] = [];
  const ids = new Set(model.fields.flatMap(field => [field.id, ...field.children.map(child => child.id)]));
  for (const item of raw) {
    object(item); object(item.field);
    if (item.parentId !== undefined) identifier(item.parentId);
    const field = parseModel({ version: 1, fields: [item.field] }, allowIncomplete).fields[0]!;
    const parent = item.parentId ? result.fields.find(f => f.id === item.parentId && f.kind === "subform") : undefined;
    if (item.parentId && !parent) throw new BadRequestException("新增字段的明细归属不存在");
    if (parent && field.kind === "subform") throw new BadRequestException("明细内不能嵌套明细");
    const scope = parent ? parent.children : result.fields;
    if (scope.some(f => f.name.trim() === field.name.trim())) throw new ConflictException("同名字段已存在，请选择已有字段或为新字段更名");
    for (const candidate of [field, ...field.children]) {
      if (ids.has(candidate.id)) throw new ConflictException("字段身份已存在，请复用已有字段");
      ids.add(candidate.id);
    }
    scope.push(field); additions.push({ ...(item.parentId ? { parentId: item.parentId } : {}), field });
  }
  return { model: parseModel(result, allowIncomplete), additions };
}
export function parsePage(raw: unknown, model: DataModel, incomplete = false): FormPageSchema {
  object(raw); object(raw.settings);
  if (raw.version !== 1 || !Array.isArray(raw.controls)) throw new BadRequestException("页面结构不合法");
  let count = 0;
  const visit = (raw: unknown, nested: boolean): PageControl => {
    object(raw); object(raw.properties); object(raw.binding); identifier(raw.id); identifier(raw.binding.fieldId);
    if (++count > 120 || !Array.isArray(raw.children) || !serverFieldTypes.includes(raw.type) || (nested && raw.type === "subform") || (raw.type !== "subform" && raw.children.length)) throw new BadRequestException("页面控件结构暂不支持");
    const properties = { ...defaultPageProperties() };
    for (const key of pagePropertyKeys) if (Object.hasOwn(raw.properties, key)) (properties as any)[key] = raw.properties[key];
    const rowPermissionErrors = subformPermissionSettingErrors({ ...properties, type: raw.type } as any);
    if (rowPermissionErrors.length) throw new BadRequestException(rowPermissionErrors[0]);
    if (properties.subformQuickFill !== undefined && (raw.type !== "subform" || typeof properties.subformQuickFill !== "boolean")) throw new BadRequestException("快速填报配置无效");
    if (properties.subformQuickFill) throw new BadRequestException("快速填报暂未接通服务端，请保留原配置");
    const widthErrors = subformWidthErrors(properties);
    if (widthErrors.length) throw new BadRequestException(widthErrors[0]);
    const fixedErrors = subformFixedColumnErrors({ ...properties, type: raw.type } as any);
    if (fixedErrors.length) throw new BadRequestException(fixedErrors[0]);
    const mobileErrors = subformMobileErrors({ ...properties, type: raw.type, children: raw.children?.map((child: any) => ({ id: child.binding?.fieldId || child.id, type: child.type })) } as any, true);
    if (mobileErrors.length) throw new BadRequestException(mobileErrors[0]);
    for (const key of ["showLabel", "required", "visible", "editable", "masked"] as const) if (typeof properties[key] !== "boolean") throw new BadRequestException("页面控件设置不合法");
    if (properties.masked || !Array.isArray(properties.tabs) || properties.tabs.length || properties.tabId) throw new BadRequestException("页面脱敏与标签页尚未接入服务端");
    if (!Number.isInteger(properties.width) || properties.width < 1 || properties.width > 12 || !Number.isInteger(properties.rows) || properties.rows < 1 || properties.rows > 50) throw new BadRequestException("控件宽度或行数不合法");
    if (typeof properties.buttonText !== "string" || properties.buttonText.length > 2000) throw new BadRequestException("按钮文字过长或格式不合法");
    return { id: raw.id, type: raw.type, binding: { fieldId: raw.binding.fieldId }, properties, children: raw.children.map((child: unknown) => visit(child, true)) };
  };
  const settings = { ...defaultPageSettings() };
  if (raw.settings.hiddenValueRules !== undefined && (!raw.settings.hiddenValueRules || typeof raw.settings.hiddenValueRules !== "object" || Array.isArray(raw.settings.hiddenValueRules) || Object.keys(raw.settings.hiddenValueRules).length)) throw new BadRequestException("特殊字段赋值规则尚未接入服务端，请保留原配置");
  for (const key of Object.keys(settings)) if (Object.hasOwn(raw.settings, key)) (settings as any)[key] = raw.settings[key];
  for (const key of ["labelAlignment", "descriptionMode", "inputWidth", "mobileLayout", "externalStyle", "frontendEvents"] as const) if (Object.hasOwn(raw.settings, key)) (settings as any)[key] = structuredClone(raw.settings[key]);
  if (settings.frontendEvents !== undefined && (!Array.isArray(settings.frontendEvents) || settings.frontendEvents.length)) throw new BadRequestException("当前服务端暂不支持前端事件，请保留原配置");
  const layoutErrors = [...formLayoutErrors(settings), ...externalStyleErrors(settings)];
  if (layoutErrors.length) throw new BadRequestException(layoutErrors[0]);
  for (const key of ["cacheDraft", "allowSubmit", "allowDraft", "allowAnotherSubmission"] as const) if (typeof settings[key] !== "boolean") throw new BadRequestException("页面提交设置不合法");
  if (!["inline", "page"].includes(settings.successMode)) throw new BadRequestException("提交结果展示方式不合法");
  if (![1, 2, 3, 4].includes(settings.layout) || !["top", "left"].includes(settings.labelPosition) || !Number.isInteger(settings.labelWidth) || settings.labelWidth < 40 || settings.labelWidth > 500 || settings.hiddenValues !== "retain") throw new BadRequestException("页面布局不合法；共享数据页面保留未展示字段的值");
  for (const key of ["description", "submitLabel", "draftLabel", "successMessage"] as const) if (typeof settings[key] !== "string" || settings[key].length > 2000) throw new BadRequestException("页面文案不合法");
  const page: FormPageSchema = { version: 1, controls: raw.controls.map((control: unknown) => visit(control, false)), settings };
  try {
    const schema = composeFormSchema(model, page);
    settings.validations = validateFormValidations(raw.settings.validations, schema.fields);
    settings.rules = validateVisibilityRules(raw.settings.rules, schema.fields);
    const conditional = new Set(settings.rules.flatMap(rule => rule.targetIds));
    for (const field of model.fields) {
      for (const candidate of [field, ...field.children]) {
        if ((conditional.has(field.id) || conditional.has(candidate.id)) && candidate.required) throw Error(`「${candidate.name}」仍有永久必填约束，请先在表单草稿中调整后再设置条件显示`);
      }
    }
    const fields = schema.fields.flatMap(field => [field, ...field.children]);
    const childIds = new Set(schema.fields.flatMap(field => field.children.map(child => child.id)));
    for (const field of fields) {
      const errors = [...fieldTextPropertiesErrors(field, childIds.has(field.id)), ...dateRangeErrors(field, dateScopeFields(schema.fields, field.id), incomplete), ...choiceSettingsErrors(field, incomplete)];
      if (errors.length) throw Error(`「${field.label}」${errors[0]}`);
    }
  } catch (error) { throw new BadRequestException((error as Error).message); }
  return page;
}
export const pageBindings = (page: FormPageSchema) => new Set(page.controls.flatMap(control => [control.binding?.fieldId, ...control.children.map(child => child.binding?.fieldId)]).filter((id): id is string => !!id));
