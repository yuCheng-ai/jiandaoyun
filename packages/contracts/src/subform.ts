import type { FormField, FormValues } from "./form";

export const maxSubformRows = 200;

export interface SubformPermissions {
  add: boolean;
  insert: boolean;
  editExisting: boolean;
  deleteExisting: boolean;
}
export const subformPermissionLabels = {
  add: "可新增记录",
  insert: "可插入记录",
  editExisting: "可编辑已有记录",
  deleteExisting: "可删除已有记录",
} as const;
export const newSubformPermissions = (): SubformPermissions => ({
  add: true,
  insert: true,
  editExisting: true,
  deleteExisting: true,
});
/** Historical forms had no insert operation. Reading them must not expand it. */
export function subformPermissions(
  value?: SubformPermissions,
): SubformPermissions {
  return value ? { ...value } : { ...newSubformPermissions(), insert: false };
}
export function parseSubformPermissions(value: unknown): SubformPermissions {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !Object.hasOwn(subformPermissionLabels, key),
    ) ||
    Object.keys(subformPermissionLabels).some(
      (key) => typeof (value as Record<string, unknown>)[key] !== "boolean",
    )
  )
    throw Error("子表单操作权限格式无效");
  return { ...(value as SubformPermissions) };
}
export function subformPermissionSettingErrors(field: FormField): string[] {
  if (field.subformPermissions === undefined) return [];
  try {
    if (field.type !== "subform") throw Error();
    parseSubformPermissions(field.subformPermissions);
    return [];
  } catch {
    return ["子表单操作权限格式无效"];
  }
}
export function existingSubformRow(
  fieldId: string,
  row: FormValues,
  index: number,
  baseline: FormValues,
): boolean {
  const rows = Array.isArray(baseline[fieldId])
    ? (baseline[fieldId] as FormValues[])
    : [];
  return rows.some(
    (old, i) =>
      subformRowId(fieldId, old, i) === subformRowId(fieldId, row, index),
  );
}
/** Explicit value replacements must enforce the same policy as row controls. */
export function subformOperationErrors(
  fields: FormField[],
  before: FormValues,
  next: FormValues,
  existing: FormValues = before,
): { fieldId: string; path: string; message: string }[] {
  return fields.flatMap((field) => {
    if (field.type === "tabs")
      return subformOperationErrors(field.children, before, next, existing);
    if (field.type !== "subform" || !Object.hasOwn(next, field.id)) return [];
    const oldRows = Array.isArray(before[field.id])
      ? (before[field.id] as FormValues[])
      : [];
    const rows = Array.isArray(next[field.id])
      ? (next[field.id] as FormValues[])
      : [];
    const policy = subformPermissions(field.subformPermissions);
    const oldIds = oldRows.map((row, index) =>
      subformRowId(field.id, row, index),
    );
    const ids = rows.map((row, index) => subformRowId(field.id, row, index));
    const editable = field.children.filter(
      (child) =>
        child.editable &&
        !["calculated", "serial", "divider", "button"].includes(child.type),
    );
    let message = "";
    if (
      oldRows.length &&
      oldRows.length !== rows.length &&
      rows.some((row) => row._rowId === undefined) &&
      (!policy.editExisting ||
        !policy.deleteExisting ||
        (!policy.insert && oldRows.some((row) => row._rowId !== undefined)))
    )
      message = "明细行信息已变化，请重新打开记录后再修改";
    const same = (a: FormValues, b: FormValues) =>
      editable.every(
        (child) => JSON.stringify(a[child.id]) === JSON.stringify(b[child.id]),
      );
    if (
      !field.editable &&
      JSON.stringify(identifySubformRows([field], before)[field.id]) !==
        JSON.stringify(identifySubformRows([field], next)[field.id])
    )
      message = "不可编辑明细";
    if (
      !message &&
      !policy.deleteExisting &&
      oldRows.some(
        (row, i) =>
          existingSubformRow(field.id, row, i, existing) &&
          !ids.includes(oldIds[i]!),
      )
    )
      message = "不可删除已有记录";
    if (
      !message &&
      !policy.editExisting &&
      rows.some((row, i) => {
        const old = previousSubformRow(field.id, oldRows, row, i);
        return (
          old &&
          existingSubformRow(field.id, row, i, existing) &&
          !same(old, row)
        );
      })
    )
      message = "不可编辑已有记录";
    const added = ids.some((id) => !oldIds.includes(id));
    if (!message && added && !policy.add && !policy.insert)
      message = "不可新增或插入记录";
    if (!message && added && !policy.insert) {
      const lastOld = ids.reduce(
        (last, id, i) => (oldIds.includes(id) ? i : last),
        -1,
      );
      if (ids.some((id, i) => !oldIds.includes(id) && i < lastOld))
        message = "不可插入记录";
    }
    return message
      ? [
          {
            fieldId: field.id,
            path: field.id,
            message: `${field.label}：${message}`,
          },
        ]
      : [];
  });
}

/** Positional identity is only a compatibility baseline for rows saved without IDs. */
export function subformRowId(
  fieldId: string,
  row: FormValues,
  index: number,
): string {
  return typeof row._rowId === "string" && row._rowId
    ? row._rowId
    : `legacy:${fieldId}:${index}`;
}

export function previousSubformRow(
  fieldId: string,
  rows: FormValues[],
  row: FormValues,
  index: number,
): FormValues | undefined {
  return row._rowId === undefined
    ? rows[index]
    : rows.find((old, i) => subformRowId(fieldId, old, i) === row._rowId);
}

/** Reading legacy rows never writes them; new UI rows receive IDs at creation. */
export function identifySubformRows(
  fields: FormField[],
  values: FormValues,
  newId?: () => string,
): FormValues {
  let result = { ...values };
  for (const field of fields) {
    if (field.type === "tabs")
      result = identifySubformRows(field.children, result, newId);
    if (field.type === "subform" && Array.isArray(values[field.id]))
      result[field.id] = (values[field.id] as FormValues[]).map((row, index) =>
        row && typeof row === "object" && !Array.isArray(row)
          ? {
              ...row,
              _rowId:
                row._rowId ??
                (newId ? newId() : subformRowId(field.id, row, index)),
            }
          : row,
      );
  }
  return result;
}

export function subformRowIdentityErrors(
  fields: FormField[],
  values: FormValues,
): { fieldId: string; path: string; message: string }[] {
  return fields.flatMap((field) => {
    if (field.type === "tabs")
      return subformRowIdentityErrors(field.children, values);
    if (field.type !== "subform" || !Array.isArray(values[field.id])) return [];
    const seen = new Set<string>();
    const invalid = (values[field.id] as FormValues[]).some((row) => {
      if (!row || row._rowId === undefined) return false;
      const id = row._rowId;
      if (typeof id !== "string" || !id || seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    return invalid
      ? [
          {
            fieldId: field.id,
            path: field.id,
            message: `${field.label}的明细行信息重复或无效，请重新打开后重试`,
          },
        ]
      : [];
  });
}

/** Existing oversized records remain readable/editable; no operation may grow them. */
export function subformRowCountIssue(
  field: Pick<FormField, "label">,
  count: number,
  previousCount = 0,
): string {
  return count > Math.max(maxSubformRows, previousCount)
    ? `${field.label}最多添加${maxSubformRows}行，当前${count}行；请减少明细后重试`
    : "";
}

/** Structural limits include hidden fields and blank rows. No values are rewritten. */
export function subformRowLimitErrors(
  fields: FormField[],
  values: FormValues,
  previous: FormValues = {},
): { fieldId: string; path: string; message: string }[] {
  return fields.flatMap((field) => {
    if (field.type === "tabs")
      return subformRowLimitErrors(field.children, values, previous);
    if (field.type !== "subform" || !Array.isArray(values[field.id])) return [];
    const message = subformRowCountIssue(
      field,
      (values[field.id] as unknown[]).length,
      Array.isArray(previous[field.id])
        ? (previous[field.id] as unknown[]).length
        : 0,
    );
    return message ? [{ fieldId: field.id, path: field.id, message }] : [];
  });
}
