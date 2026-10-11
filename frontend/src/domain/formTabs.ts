import {
  copy,
  uid,
  findField,
  flattenFields,
  countFormFields,
  fieldCountLimitError,
  duplicateFields,
  type FormField,
  type FormSchema,
} from "./form";

export const minFormTabs = 2;
export const maxFormTabs = 50;
export type FormTabAction =
  | { type: "add" }
  | { type: "copy" | "remove"; tabId: string }
  | { type: "move"; tabId: string; index: number };

/** Return one complete editor change; failed operations leave the draft intact. */
export function editFormTabs(
  schema: FormSchema,
  fieldId: string,
  action: FormTabAction,
): { schema: FormSchema; tabId: string } {
  const next = copy(schema);
  const field = findField(next.fields, fieldId);
  if (!field || field.type !== "tabs")
    throw Error("多标签页已变化，请重新选择");
  const index =
    "tabId" in action
      ? field.tabs.findIndex((tab) => tab.id === action.tabId)
      : -1;
  if ("tabId" in action && index < 0) throw Error("标签页已变化，请重新选择");
  if (["add", "copy"].includes(action.type) && field.tabs.length >= maxFormTabs)
    throw Error("最多允许添加 50 个标签页");
  if (action.type === "remove" && field.tabs.length <= minFormTabs)
    throw Error("至少需要保留 2 个标签页");

  if (action.type === "add") {
    const tabId = uid("tab");
    field.tabs.push({ id: tabId, label: `标签页${field.tabs.length + 1}` });
    return { schema: next, tabId };
  }
  if (action.type === "move") {
    if (
      !Number.isInteger(action.index) ||
      action.index < 0 ||
      action.index >= field.tabs.length
    )
      throw Error("请选择有效的标签页位置");
    const [tab] = field.tabs.splice(index, 1);
    field.tabs.splice(action.index, 0, tab!);
    return { schema: next, tabId: action.tabId };
  }
  if (action.type === "remove") {
    const moved = field.children.filter(
      (child) => child.tabId === action.tabId,
    );
    field.children = field.children.filter(
      (child) => child.tabId !== action.tabId,
    );
    moved.forEach((child) => delete child.tabId);
    // Legacy nested tabs are retained on load; removing one still returns its fields to the body.
    const ownerIndex = next.fields.indexOf(field);
    next.fields.splice(
      ownerIndex < 0 ? next.fields.length : ownerIndex + 1,
      0,
      ...moved,
    );
    field.tabs.splice(index, 1);
    return {
      schema: next,
      tabId: field.tabs[Math.min(index, field.tabs.length - 1)]!.id,
    };
  }

  function withoutSerial(fields: FormField[]): FormField[] {
    return fields
      .filter((child) => child.type !== "serial")
      .map((child) => ({
        ...child,
        children: withoutSerial(child.children),
      }));
  }
  const originals = withoutSerial(
    field.children.filter((child) => child.tabId === action.tabId),
  );
  if (flattenFields(originals).some((child) => child.type === "tabs"))
    throw Error("一个表单只能添加一个多标签页字段");
  if (countFormFields(next.fields) + countFormFields(originals) > 300)
    throw Error("单个表单最多 300 个字段");
  const calculationError = fieldCountLimitError(
    [...next.fields, ...originals],
    schema.fields,
  );
  if (calculationError) throw Error(calculationError);
  const { fields, idMap } = duplicateFields(originals);
  const tabId = uid("tab");
  flattenFields(fields).forEach((child) => {
    child.label += "_拷贝";
  });
  fields.forEach((child) => {
    child.tabId = tabId;
  });
  field.tabs.splice(index + 1, 0, {
    id: tabId,
    label: `${field.tabs[index]!.label}_拷贝`,
  });
  field.children.push(...fields);
  // Only the copied targets get copied visibility rules; external targets remain untouched.
  for (const rule of schema.settings.rules) {
    const targetIds = rule.targetIds
      .filter((id) => idMap.has(id))
      .map((id) => idMap.get(id)!);
    if (!targetIds.length) continue;
    const copied = { ...copy(rule), id: uid("rule"), targetIds };
    if ("conditions" in copied)
      copied.conditions = copied.conditions.map((condition) => ({
        ...condition,
        sourceId: idMap.get(condition.sourceId) || condition.sourceId,
      }));
    else copied.sourceId = idMap.get(copied.sourceId) || copied.sourceId;
    next.settings.rules.push(copied);
  }
  return { schema: next, tabId };
}
