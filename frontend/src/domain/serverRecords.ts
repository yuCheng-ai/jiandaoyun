import type {
  AccessGrant,
  CellChange,
  FormField,
  FormValues,
  PublishedAccess,
  RecordDetail,
  RowChange,
} from "@platform/contracts";
import { fieldDefaultValue, subformRowLimitErrors } from "@platform/contracts";
export function canEditField(
  access: AccessGrant,
  field: FormField,
  parent?: FormField,
) {
  return (
    access.fields[field.id] === "edit" &&
    (!parent || access.fields[parent.id] === "edit")
  );
}
export function emptyServerRecord(
  published: PublishedAccess,
  now = new Date(),
): FormValues {
  return Object.fromEntries(
    published.definition.schema.fields
      .filter((f) => canEditField(published.access, f))
      .map((f) => [
        f.id,
        f.type === "subform"
          ? []
          : f.type === "datetime" && f.dateDefault === "now"
            ? fieldDefaultValue(f, now)
            : (published.defaultValues?.[f.id] ?? f.defaultValue),
      ]),
  );
}
export function recordChanges(
  detail: RecordDetail,
  edited: FormValues,
): CellChange[] {
  const changes: CellChange[] = [];
  const add = (
    field: FormField,
    before: unknown,
    value: unknown,
    subformId?: string,
    rowId?: string,
  ) => {
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    const key = subformId ? `${subformId}/${rowId}/${field.id}` : field.id;
    changes.push({
      fieldId: field.id,
      ...(subformId ? { subformId, rowId } : {}),
      value,
      expectedRevision: detail.record.cellRevisions[key]!,
    });
  };
  for (const field of detail.definition.schema.fields) {
    if (field.type === "subform") {
      const rows = edited[field.id] as FormValues[];
      for (const original of detail.record.values[field.id] as FormValues[]) {
        const current = rows.find((row) => row._rowId === original._rowId);
        if (!current) continue;
        for (const child of field.children)
          if (canEditField(detail.access, child, field))
            add(
              child,
              original[child.id],
              current[child.id],
              field.id,
              String(original._rowId),
            );
      }
    } else if (canEditField(detail.access, field))
      add(field, detail.record.values[field.id], edited[field.id]);
  }
  return changes;
}
export function recordRowChanges(
  detail: RecordDetail,
  edited: FormValues,
): RowChange[] {
  const issue = subformRowLimitErrors(
    detail.definition.schema.fields,
    edited,
    detail.record.values,
  )[0];
  if (issue) throw Error(issue.message);
  const changes: RowChange[] = [];
  for (const field of detail.definition.schema.fields.filter(
    (field) => field.type === "subform",
  )) {
    const before = detail.record.values[field.id] as FormValues[],
      after = edited[field.id] as FormValues[];
    const ids = new Set(before.map((row) => String(row._rowId)));
    const currentIds = new Set(after.map((row) => String(row._rowId)));
    if (currentIds.size !== after.length)
      throw new Error("明细行身份重复，请重新检查");
    const expectedRevision = detail.record.rowRevisions?.[field.id] || 1;
    for (const row of before)
      if (!currentIds.has(String(row._rowId))) {
        if (!detail.rowActions?.[field.id]?.remove)
          throw new Error("当前页面或成员权限不能删除完整明细行");
        changes.push({
          action: "remove",
          subformId: field.id,
          rowId: String(row._rowId),
          expectedRevision,
          expectedCells: Object.fromEntries(
            field.children.map((child) => {
              const key = `${field.id}/${row._rowId}/${child.id}`;
              return [key, detail.record.cellRevisions[key]!];
            }),
          ),
        });
      }
    for (const row of after)
      if (!ids.has(String(row._rowId))) {
        if (!detail.rowActions?.[field.id]?.add)
          throw new Error("没有新增明细行的权限");
        if (typeof row._rowId !== "string" || !row._rowId.startsWith("draft:"))
          throw new Error("新增明细行身份不合法");
        changes.push({
          action: "add",
          subformId: field.id,
          expectedRevision,
          values: Object.fromEntries(
            field.children
              .filter((child) => canEditField(detail.access, child, field))
              .map((child) => [child.id, row[child.id]]),
          ),
        });
      }
  }
  return changes;
}

/** An entry's creation mask never implies permission to list submitted data. */
export function canReadRecordDrafts(access: AccessGrant) {
  return access.create || (access.read && !access.groupSelection);
}
export function recordStateForAccess(
  access: AccessGrant,
  state: "active" | "draft",
) {
  if (!access.read && access.create) return "draft";
  return state === "draft" && !canReadRecordDrafts(access) ? "active" : state;
}
export function recordSavedNotice(result: RecordDetail) {
  if (result.accessLost) return "已保存，当前权限不能查看这条记录。";
  return result.record.state === "draft"
    ? "草稿已保存，可从草稿列表继续填写。"
    : "记录已保存。";
}
