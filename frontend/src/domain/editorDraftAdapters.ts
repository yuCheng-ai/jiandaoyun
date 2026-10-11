import {
  isFileValue,
  isAddressValue,
  previousSubformRow,
  subformRowIdentityErrors,
  existingSubformRow,
  subformPermissions,
  subformRowId,
} from "@platform/contracts";
import { checkedDraftValue } from "./editorDrafts";
import {
  copy,
  defaultValues,
  resolveCalculations,
  type FormField,
  type FormValues,
} from "./form";
import { parseExtensions } from "./extensions";
import {
  scopeFields,
  subformFillingBaseline,
  runtimeDefaults,
  applyFieldChange,
  resolveChoices,
} from "./relations";
import type { WorkspaceData } from "./workspace";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("暂存内容应为对象");
  return value as Record<string, unknown>;
}
export function restoreProfileDraft(value: unknown) {
  const raw = object(checkedDraftValue(value));
  for (const key of ["name", "email", "phone"])
    if (typeof raw[key] !== "string" || (raw[key] as string).length > 1000)
      throw Error("个人信息暂存格式无效");
  return {
    name: raw.name as string,
    email: raw.email as string,
    phone: raw.phone as string,
  };
}
export function restoreWebhookDraft(value: unknown, expectedId?: string) {
  const raw = object(checkedDraftValue(value));
  if (
    !raw.id ||
    typeof raw.id !== "string" ||
    (expectedId && raw.id !== expectedId)
  )
    throw Error("数据推送暂存不属于此配置");
  return parseExtensions({ webhooks: [raw] }).webhooks[0]!;
}
/** Restore editable inputs only. Domain validation still runs on the later explicit save. */
export function restoreRuntimeDraft(
  value: unknown,
  fields: FormField[],
  current: FormValues,
  existing: FormValues = current,
): FormValues {
  const raw = object(checkedDraftValue(value)),
    scoped = scopeFields(fields, true),
    next = copy(current);
  if (Object.keys(raw).some((id) => !scoped.some((f) => f.id === id)))
    throw Error("暂存中存在当前表单没有的字段");
  for (const field of scoped) {
    if (
      !Object.hasOwn(raw, field.id) ||
      !field.visible ||
      !field.editable ||
      field.masked ||
      field.type === "calculated"
    )
      continue;
    const input = raw[field.id];
    const invalid = () => {
      throw Error(`“${field.label}”的暂存格式无效`);
    };
    if (field.type === "subform") {
      if (!Array.isArray(input)) invalid();
      const previous = Array.isArray(current[field.id])
        ? (current[field.id] as FormValues[])
        : [];
      if (
        previous.length &&
        (input as unknown[]).length &&
        previous.length !== (input as unknown[]).length &&
        (input as unknown[]).some((row) => object(row)._rowId === undefined) &&
        scopeFields(field.children).some(
          (child) => !child.editable || child.masked,
        )
      )
        throw Error(`${field.label}的暂存明细无法对应原记录，当前记录保持不变`);
      next[field.id] = (input as unknown[]).map((row, i) => {
        const { _rowId, ...editable } = object(row);
        const old = existingSubformRow(field.id, object(row), i, existing);
        const mode = old
          ? "existing"
          : (input as unknown[])
                .slice(i + 1)
                .some((later, offset) =>
                  existingSubformRow(
                    field.id,
                    object(later),
                    i + 1 + offset,
                    existing,
                  ),
                )
            ? "insert"
            : "append";
        const restored = restoreRuntimeDraft(
          editable,
          field.children.map((child) => ({
            ...child,
            editable:
              child.editable &&
              (!old ||
                subformPermissions(field.subformPermissions).editExisting) &&
              child.rowEditAccess?.[mode] !== false,
          })),
          previousSubformRow(field.id, previous, object(row), i) ||
            defaultValues(field.children),
        );
        if (_rowId !== undefined) restored._rowId = _rowId;
        return restored;
      });
      const identityIssue = subformRowIdentityErrors([field], next)[0];
      if (identityIssue) throw Error(identityIssue.message);
    } else if (
      [
        "checkbox",
        "multiselect",
        "members",
        "departments",
        "relationTable",
      ].includes(field.type)
    ) {
      if (!Array.isArray(input) || !input.every((v) => typeof v === "string"))
        invalid();
      next[field.id] = input;
    } else if (["image", "file"].includes(field.type)) {
      if (!Array.isArray(input)) invalid();
      next[field.id] = (input as unknown[]).map((item) => {
        const file = object(item);
        if (
          !isFileValue(file) ||
          (file.preview !== undefined && typeof file.preview !== "string")
        )
          invalid();
        if (
          file.preview &&
          !/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(
            file.preview as string,
          )
        )
          invalid();
        return {
          name: file.name,
          size: file.size,
          type: file.type,
          ...(file.id !== undefined ? { id: file.id } : {}),
          ...(file.preview !== undefined ? { preview: file.preview } : {}),
        };
      });
    } else if (field.type === "address" && input !== "") {
      if (!isAddressValue(input)) invalid();
      next[field.id] = copy(input);
    } else {
      if (
        input !== null &&
        typeof input !== "string" &&
        typeof input !== "number"
      )
        invalid();
      if (
        field.type === "signature" &&
        input &&
        !/^data:image\/png;base64,/.test(String(input))
      )
        invalid();
      next[field.id] = input;
    }
  }
  return next;
}

/** Rebase generated rows on the restored inputs; cached values never authorize protected writes. */
export function restoreFillingDraft(
  value: unknown,
  fields: FormField[],
  current: FormValues,
  data: WorkspaceData,
  previousGenerated?: unknown,
): { values: FormValues; existingRows: FormValues } {
  const raw = object(checkedDraftValue(value));
  const editableInputs = restoreRuntimeDraft(raw, fields, current, {});
  let inputs = editableInputs;
  // Run the same main-field dependencies as ordinary input before reading linked rows.
  // Explicit editable overrides are restored afterwards; derived readonly values stay fresh.
  for (const field of scopeFields(fields))
    if (
      !["subform", "tabs", "calculated"].includes(field.type) &&
      field.editable &&
      !field.masked &&
      Object.hasOwn(raw, field.id) &&
      JSON.stringify(editableInputs[field.id]) !==
        JSON.stringify(current[field.id])
    )
      inputs = applyFieldChange(
        fields,
        inputs,
        field.id,
        editableInputs[field.id],
        data,
        {},
        fields,
        false,
      );
  inputs = resolveCalculations(
    fields,
    restoreRuntimeDraft(raw, fields, inputs, {}),
    {},
    {
      defaults: scopeFields(fields)
        .filter((field) => field.defaultFormula && !field.editable)
        .map((field) => field.id),
      fields,
      choices: (field, values) => resolveChoices(field, data, values, fields),
    },
  );
  const existingRows = subformFillingBaseline(fields, data, inputs);
  const prior =
    previousGenerated === undefined
      ? subformFillingBaseline(fields, data, current)
      : restoreRuntimeDraft(previousGenerated, fields, current, {});
  const candidate = copy(raw),
    seed = copy(inputs);
  for (const field of scopeFields(fields).filter(
    (field) => field.type === "subform",
  )) {
    if (!Array.isArray(raw[field.id])) continue;
    const cached = raw[field.id] as FormValues[];
    const oldRows = Array.isArray(prior[field.id])
      ? (prior[field.id] as FormValues[])
      : [];
    const fresh = existingRows[field.id] as FormValues[];
    const oldIds = new Set(
      oldRows.map((row, i) => subformRowId(field.id, row, i)),
    );
    const freshIds = new Set(
      fresh.map((row, i) => subformRowId(field.id, row, i)),
    );
    const rows = cached.filter(
      (row, i) =>
        !oldIds.has(subformRowId(field.id, row, i)) ||
        freshIds.has(subformRowId(field.id, row, i)),
    );
    const added = fresh.filter(
      (row, i) => !oldIds.has(subformRowId(field.id, row, i)),
    );
    // Keep inserted manual rows in place and put newly generated rows before the manual tail.
    const lastGenerated = rows.reduce(
      (last, row, i) =>
        freshIds.has(subformRowId(field.id, row, i)) ? i : last,
      -1,
    );
    rows.splice(lastGenerated + 1, 0, ...added);
    candidate[field.id] = rows;
    const defaults = runtimeDefaults(field.children, data, inputs, fields);
    seed[field.id] = rows.map((row, i) => ({
      ...(previousSubformRow(field.id, fresh, row, i) ||
        previousSubformRow(
          field.id,
          (current[field.id] || []) as FormValues[],
          row,
          i,
        ) ||
        defaults),
      ...("_rowId" in row ? { _rowId: row._rowId } : {}),
    }));
  }
  return {
    values: restoreRuntimeDraft(candidate, fields, seed, existingRows),
    existingRows,
  };
}
