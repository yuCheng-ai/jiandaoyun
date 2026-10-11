import {
  addressParts,
  emptyFieldValue,
  isAddressValue,
  maxSubformRows,
  selectableDateValue,
  subformRowId,
  type AddressValue,
  type FrontendFieldChange,
} from "@platform/contracts";
import {
  copy,
  isFieldVisible,
  uid,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import {
  applyFieldChange,
  fieldInputDependencies,
  resolveChoices,
  runtimeDefaults,
} from "./relations";
import { importFieldValue, importExcelValue } from "./recordImport";
import { addressValueIssue } from "./address";
import type { WorkspaceData } from "./workspace";

export type SubformFillMode = "add" | "edit";
export type SubformFillColumn = {
  key: string;
  label: string;
  field: FormField;
  part?: keyof AddressValue;
};
export type SubformFillError = { row: number; column: number; message: string };
const supported = new Set([
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
  "address",
]);
const multi = new Set(["checkbox", "multiselect", "members", "departments"]);
const org = new Set(["member", "members", "department", "departments"]);
export function subformFillColumns(
  field: FormField,
  schema: FormSchema,
  contexts: FormValues[],
  mode: SubformFillMode,
  external = false,
): SubformFillColumn[] {
  return field.children
    .filter(
      (child) =>
        supported.has(child.type) &&
        !child.masked &&
        (!external || !org.has(child.type)) &&
        (mode === "edit" ||
          (child.editable && child.rowEditAccess?.append !== false)) &&
        contexts.some((values) => isFieldVisible(child, schema, values)),
    )
    .flatMap((child) =>
      child.type === "address"
        ? addressParts(child).map((part) => ({
            key: `${child.id}/${part}`,
            field: child,
            part,
            label: `${child.label}·${{ province: "省", city: "市", district: "区", detail: "详细地址" }[part]}`,
          }))
        : [{ key: child.id, field: child, label: child.label }],
    );
}
export function subformFillText(
  column: SubformFillColumn,
  row: FormValues,
  data: WorkspaceData,
): string {
  return String(
    importExcelValue(
      column.field,
      { values: row },
      data,
      undefined,
      column.part,
    ) ?? "",
  );
}
/** Excel quotes tabs/newlines inside cells. Do not split these into different rows. */
export function parseSheetText(text: string): string[][] {
  const rows: string[][] = [[]];
  let value = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"' && (quoted || value === "")) {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === "\t" || char === "\r" || char === "\n")) {
      rows.at(-1)!.push(value);
      value = "";
      if (char !== "\t") {
        rows.push([]);
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else value += char;
  }
  rows.at(-1)!.push(value);
  if (rows.length > 1 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "")
    rows.pop();
  return rows;
}
export function sheetText(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) =>
          /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value,
        )
        .join("\t"),
    )
    .join("\n");
}
function fillValue(
  field: FormField,
  input: string | AddressValue,
  context: FormValues,
  data: WorkspaceData,
  inputFields: FormField[],
): { value: unknown; message?: string } {
  if (emptyFieldValue(input))
    return { value: importFieldValue(field, input, context, data, false, undefined, inputFields) };
  if (field.type === "address") {
    const issue = addressValueIssue(
      { ...field, addressComplete: false },
      input,
    );
    return {
      value: issue ? { detail: (input as AddressValue).detail || "" } : input,
      message: issue,
    };
  }
  if (["radio", "select", "checkbox", "multiselect"].includes(field.type)) {
    const options = resolveChoices(field, data, context, inputFields);
    const tokens = multi.has(field.type)
      ? String(input)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [String(input).trim()];
    const values: unknown[] = [],
      invalid: string[] = [];
    for (const text of tokens) {
      const matches = options.filter(
        (option) => option.id === text || option.label === text,
      );
      if (matches.length === 1) values.push(matches[0]!.id);
      else if (
        !matches.length &&
        field.choiceSource.mode === "manual" &&
        !field.defaultLink?.enabled &&
        multi.has(field.type) &&
        field.allowCustomChoices
      )
        values.push({ text });
      else {
        const other =
          !multi.has(field.type) &&
          field.choiceSource.mode === "manual" &&
          !field.defaultLink?.enabled &&
          options.find((option) => option.other);
        if (other && !matches.length) values.push({ optionId: other.id, text });
        else invalid.push(text);
      }
    }
    return {
      value: multi.has(field.type)
        ? values.filter(
            (value, i) =>
              values.findIndex(
                (other) => JSON.stringify(other) === JSON.stringify(value),
              ) === i,
          )
        : values[0] || "",
      message: invalid.length ? `选项不匹配：${invalid.join("、")}` : undefined,
    };
  }
  if (org.has(field.type) && multi.has(field.type)) {
    const values: string[] = [],
      invalid: string[] = [];
    for (const text of String(input)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      try {
        const value = importFieldValue(
          {
            ...field,
            type: field.type === "members" ? "member" : "department",
          },
          text,
          context,
          data,
          false,
        ) as string;
        if (!values.includes(value)) values.push(value);
      } catch {
        invalid.push(text);
      }
    }
    return {
      value: values,
      message: invalid.length
        ? `不在可选范围或有重名：${invalid.join("、")}`
        : undefined,
    };
  }
  try {
    const value = importFieldValue(field, input, context, data, false, undefined, inputFields);
    if (field.type === "number" && value === null)
      return { value, message: "请输入有效数字" };
    if (field.type === "datetime") {
      const date = copy(field);
      if (date.dateRange)
        for (const key of ["earliest", "latest"] as const)
          if (date.dateRange[key].mode === "field")
            date.dateRange[key].enabled = false;
      if (!value || !selectableDateValue(date, String(value), context))
        return { value: "", message: "日期无效或不在可选范围内" };
    }
    return { value };
  } catch (error) {
    return {
      value: multi.has(field.type) ? [] : "",
      message: (error as Error).message,
    };
  }
}
export function blankSubformPlaceholder(
  field: FormField,
  rows: FormValues[],
): boolean {
  return (
    rows.length === 1 &&
    field.children.every((child) => emptyFieldValue(rows[0]![child.id]))
  );
}
export function prepareSubformFill(options: {
  field: FormField;
  schema: FormSchema;
  root: FormValues;
  before: FormValues[];
  mode: SubformFillMode;
  grid: string[][];
  columns: SubformFillColumn[];
  mapping: string[];
  data: WorkspaceData;
  editable: (
    child: FormField,
    row: FormValues,
    index: number,
    mode: SubformFillMode,
  ) => boolean;
}) {
  const {
    field,
    schema,
    root,
    before,
    mode,
    columns,
    mapping,
    data,
    editable,
  } = options;
  const mapped = mapping.filter(Boolean);
  if (new Set(mapped).size !== mapped.length)
    throw Error("同一字段只能匹配一列，请调整字段匹配");
  if (mapped.some((key) => !columns.some((column) => column.key === key)))
    throw Error("字段已变化，请重新打开快速填报");
  const grid =
    mode === "add"
      ? options.grid.filter((row) => row.some((value) => value.trim()))
      : options.grid;
  const replaceBlank = mode === "add" && blankSubformPlaceholder(field, before);
  if (
    (mode === "add" &&
      before.length + grid.length - Number(replaceBlank) > maxSubformRows) ||
    (mode === "edit" && grid.length !== before.length)
  )
    throw Error(
      mode === "add"
        ? `最多添加${maxSubformRows}行，请减少填报内容`
        : "明细行数已变化，请重新打开快速填报",
    );
  const rows = copy(before),
    errors: SubformFillError[] = [],
    changes: FrontendFieldChange[] = [];
  grid.forEach((cells, position) => {
    const index =
      mode === "edit"
        ? position
        : (replaceBlank ? 0 : before.length) + position;
    let row: FormValues =
      mode === "edit"
        ? copy(before[position]!)
        : {
            ...runtimeDefaults(field.children, data, root, schema.fields),
            _rowId:
              replaceBlank && !position
                ? subformRowId(field.id, before[0]!, 0)
                : uid("row"),
          };
    const inputs = new Map<
      string,
      { field: FormField; value: string | AddressValue; columns: number[] }
    >();
    mapping.forEach((key, columnIndex) => {
      const source = columns[columnIndex];
      if (
        mode === "edit" &&
        (!source || !editable(source.field, before[position]!, index, mode))
      )
        return;
      const column = columns.find((column) => column.key === key);
      if (!column || !editable(column.field, row, index, mode)) return;
      const raw = cells[columnIndex] ?? "";
      if (
        mode === "edit" &&
        key === columns[columnIndex]?.key &&
        raw === subformFillText(column, before[position]!, data)
      )
        return;
      let input = inputs.get(column.field.id);
      if (!input) {
        input = {
          field: column.field,
          value: column.part
            ? {
                ...(isAddressValue(row[column.field.id])
                  ? (row[column.field.id] as AddressValue)
                  : {}),
              }
            : raw,
          columns: [],
        };
        inputs.set(column.field.id, input);
      }
      if (column.part) (input.value as AddressValue)[column.part] = raw;
      input.columns.push(columnIndex);
    });
    const order: string[] = [],
      visiting = new Set<string>();
    function visit(id: string) {
      if (order.includes(id) || visiting.has(id)) return;
      visiting.add(id);
      const input = inputs.get(id);
      if (input)
        fieldInputDependencies(input.field)
          .filter((dep) => inputs.has(dep))
          .forEach(visit);
      order.push(id);
    }
    inputs.forEach((_, id) => visit(id));
    for (const id of order) {
      const input = inputs.get(id)!;
      const result = fillValue(
        input.field,
        input.value,
        { ...root, ...row },
        data,
        schema.fields,
      );
      if (result.message)
        input.columns.forEach((column) =>
          errors.push({ row: position, column, message: result.message! }),
        );
      row = applyFieldChange(
        field.children,
        row,
        id,
        result.value,
        data,
        root,
        schema.fields,
      );
    }
    // Later dependency writes must not bypass row/column or visibility restrictions.
    if (mode === "edit")
      for (const child of field.children)
        if (
          !editable(child, before[position]!, index, mode) &&
          !child.defaultFormula &&
          !child.defaultLink?.enabled &&
          child.type !== "calculated"
        ) {
          const previous = before[position]!;
          if (Object.hasOwn(previous, child.id))
            row[child.id] =
              previous[child.id] === undefined
                ? undefined
                : copy(previous[child.id]);
          else delete row[child.id];
        }
    for (const child of field.children)
      if (
        editable(child, row, index, mode) &&
        (mode === "add" ||
          JSON.stringify(row[child.id]) !==
            JSON.stringify(before[position]?.[child.id]))
      )
        changes.push({
          fieldId: child.id,
          row: { subformId: field.id, index },
        });
    rows[index] = row;
  });
  return { rows, changes, errors };
}
