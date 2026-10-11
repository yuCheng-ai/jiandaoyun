import { composeFormSchema, separateFormSchema, modelFormSchema, dataKind, dataFields, pagePropertyKeys, type PublishedDataModel, type DataField, type DataFieldAddition, type DataModel, type PageEditorData, type RecycledField } from "@platform/contracts";
import { copy, parseSchema, type FormSchema, type FormField } from "./form";

export interface PageEditingState { title: string; schema: FormSchema; fieldTrash?: RecycledField[] }
export function previewDataModel(data: PageEditorData): DataModel {
  if (data.draft.formModel) return copy(data.draft.formModel);
  const model = copy(data.model);
  for (const addition of data.draft.additions) {
    const fields = addition.parentId ? model.fields.find(field => field.id === addition.parentId)?.children : model.fields;
    if (!fields) throw new Error("新增字段所属的明细不存在，请重新读取页面草稿");
    fields.push(copy(addition.field));
  }
  return model;
}
export function pageEditingState(data: PageEditorData): PageEditingState {
  return { title: data.draft.title, fieldTrash: copy(data.draft.fieldTrash || []), schema: parseSchema(composeFormSchema(previewDataModel(data), data.draft.schema)) };
}
export const modelFields = dataFields;
/** Refresh a page's model without inserting controls or discarding its local edits. */
export function adoptPageModel(data: PageEditorData, state: PageEditingState, latest: PublishedDataModel) {
  if (!latest.object.latestVersion) throw new Error("数据对象尚未发布，请先在数据管理发布字段，再回到本页采用；当前修改已保留。");
  if (latest.object.id !== data.draft.definitionId || latest.object.latestVersion < data.draft.definitionVersion) throw new Error("数据对象或版本不匹配，请重新读取");
  const update = pageUpdate(data, state);
  const fresh: PageEditorData = { object: copy(latest.object), model: copy(latest.model), draft: { ...copy(data.draft), ...update, definitionVersion: latest.object.latestVersion, baseDefinitionRevision: update.additions.length ? latest.object.revision : null } };
  const ids = new Set(modelFields(latest.model).map(item => item.field.id));
  for (const addition of update.additions) {
    const fields = addition.parentId ? latest.model.fields.find(field => field.id === addition.parentId)?.children : latest.model.fields;
    if (!fields) throw new Error(`新增字段「${addition.field.name}」的明细已被调整，请先处理该字段`);
    if (fields.some(field => field.name.trim() === addition.field.name.trim()) || modelFields({ version: 1, fields: [addition.field] }).some(item => ids.has(item.field.id))) throw new Error(`「${addition.field.name}」已在新版数据中存在，请先取消本页新增字段，再从已有字段复用`);
  }
  try { return { data: fresh, state: pageEditingState(fresh) }; }
  catch { throw new Error("本页仍使用新版已移除或变更归属的字段。请先移除对应控件，再更新数据字段；当前修改已保留。"); }
}
export function pageUpdate(data: PageEditorData, state: PageEditingState) {
  const base = new Map(modelFields(data.model).map(item => [item.field.id, item]));
  const converted = separateFormSchema(state.schema), additions: DataFieldAddition[] = [];
  const verify = (fields: FormField[], parentId?: string) => {
    for (const field of fields) {
      const known = base.get(field.id);
      if (known && (known.parentId !== parentId || dataKind(field.type) !== known.field.kind)) throw new Error("已有字段不能改变所属数据或类型，请移除控件后选择对应范围的字段");
      verify(field.children, field.type === "subform" ? field.id : parentId);
    }
  };
  verify(state.schema.fields);
  if (data.canEditFields) {
    // Loading an older schema supplies editor defaults. Do not persist those as
    // field changes unless the user actually changed the corresponding setting.
    const defaults = new Map(modelFields(separateFormSchema(parseSchema(modelFormSchema(data.model))).model).map(item => [item.field.id, item.field.settings]));
    for (const { field } of modelFields(converted.model)) {
      const original = base.get(field.id)?.field.settings;
      if (!original) continue;
      const baseline = defaults.get(field.id)!;
      for (const key of Object.keys(field.settings) as (keyof DataField["settings"])[]) {
        if (JSON.stringify(field.settings[key]) !== JSON.stringify(baseline[key])) continue;
        if (Object.hasOwn(original, key)) Object.assign(field.settings, { [key]: copy(original[key]) });
        else delete field.settings[key];
      }
    }
    return {
      title: state.title, fieldTrash: copy(state.fieldTrash || []), definitionId: data.draft.definitionId,
      definitionVersion: data.draft.definitionVersion,
      expectedRevision: data.draft.revision,
      baseDefinitionRevision: data.draft.baseDefinitionRevision ?? data.object.revision,
      schema: converted.page, additions: [], formModel: converted.model,
    };
  }
  const makeOptional = (field: DataField): DataField => ({ ...copy(field), required: false, children: field.children.map(makeOptional) });
  for (const field of converted.model.fields) {
    if (!base.has(field.id)) additions.push({ field: makeOptional(field) });
    else for (const child of field.children) if (!base.has(child.id)) additions.push({ parentId: field.id, field: makeOptional(child) });
  }
  const labels = new Map(modelFields(converted.model).map(item => [item.field.id, item.field.name]));
  for (const control of converted.page.controls.flatMap(control => [control, ...control.children])) {
    const id = control.binding?.fieldId;
    if (id && base.has(id)) control.properties.label = labels.get(id) === base.get(id)!.field.name ? null : labels.get(id)!;
  }
  return {
    title: state.title, fieldTrash: copy(state.fieldTrash || []), definitionId: data.draft.definitionId,
    definitionVersion: data.draft.definitionVersion,
    expectedRevision: data.draft.revision,
    baseDefinitionRevision: additions.length ? data.draft.baseDefinitionRevision ?? data.object.revision : null,
    schema: converted.page, additions,
  };
}
export function pageFieldNames(data: PageEditorData, state: PageEditingState, parentId?: string) {
  const names = data.canEditFields ? [] : modelFields(data.model).filter(item => item.parentId === parentId).map(item => item.field.name);
  const current = parentId ? state.schema.fields.find(field => field.id === parentId)?.children || [] : state.schema.fields;
  return new Set([...names, ...current.map(field => field.label)]);
}

export function pageFieldConflicts(data: PageEditorData, state: PageEditingState) {
  if (data.canEditFields) return [];
  const base = modelFields(data.model), known = new Set(base.map(item => item.field.id));
  const current = state.schema.fields.flatMap(field => [{ field, parentId: undefined as string | undefined }, ...field.children.map(child => ({ field: child, parentId: field.id }))]);
  return current.filter(item => !known.has(item.field.id)).flatMap(item => {
    const name = item.field.label.trim();
    const existing = base.find(other => other.parentId === item.parentId && other.field.name.trim() === name);
    const pending = current.find(other => other.field.id !== item.field.id && !known.has(other.field.id) && other.parentId === item.parentId && other.field.label.trim() === name);
    if (!existing && !pending) return [];
    return [{ field: item.field, parentId: item.parentId, existing: existing?.field, pending: pending?.field,
      alreadyPlaced: !!existing && current.some(other => other.field.id === existing.field.id) }];
  });
}

/** Explicitly reviewed replacement: retain page properties and never invent a second data identity. */
export function planFieldReuse(data: PageEditorData, state: PageEditingState, pendingId: string, existingId: string) {
  const current = state.schema.fields.flatMap(field => [{ field, parentId: undefined as string | undefined }, ...field.children.map(child => ({ field: child, parentId: field.id }))]);
  const pending = current.find(item => item.field.id === pendingId), base = modelFields(data.model);
  const existing = base.find(item => item.field.id === existingId);
  if (!pending || !existing || base.some(item => item.field.id === pendingId) || pending.parentId !== existing.parentId) throw new Error("请选择同一范围内的新增字段和已有字段");
  if (current.some(item => item.field.id === existingId)) throw new Error("已有字段已在本页，请定位该控件并取消重复的新字段");
  const bindings: { name: string; fieldId: string }[] = [], additions: string[] = [];
  const bind = (field: FormField, target: DataField): FormField => {
    if (dataKind(field.type) !== target.kind) throw new Error(`「${field.label}」与已有字段类型不同，请更名或取消新增后使用已有字段`);
    if (bindings.some(binding => binding.fieldId === target.id)) throw new Error(`「${field.label}」有重复控件，请先处理同名明细列`);
    bindings.push({ name: target.name, fieldId: target.id });
    const replacement = parseSchema(composeFormSchema({ version: 1, fields: [target] }, {
      version: 1, controls: [{ id: target.id, binding: { fieldId: target.id }, type: field.type,
        properties: Object.fromEntries(pagePropertyKeys.map(key => [key, field[key]])) as any, children: [] }], settings: state.schema.settings,
    })).fields[0]!;
    replacement.required ||= target.required;
    replacement.children = field.children.map(child => {
      const match = target.children.find(candidate => candidate.name.trim() === child.label.trim());
      if (match) return bind(child, match);
      additions.push(child.label); return copy(child);
    });
    return replacement;
  };
  const replacement = bind(pending.field, existing.field);
  return { parentId: pending.parentId, replacement, bindings, additions };
}
