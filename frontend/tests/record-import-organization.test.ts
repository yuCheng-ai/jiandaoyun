import { expect, it } from "vitest";
import { copy, createField, type FormField } from "../src/domain/form";
import { seedWorkspace, type FormEntry } from "../src/domain/workspace";
import {
  importExcelValue,
  prepareImportRows,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import { recordExcelExport } from "../src/domain/records";
import { excelBytes, readExcel } from "../src/services/excel";

function fixture() {
  const data = seedWorkspace(),
    form = data.forms[0]!;
  const fields = [
    createField("member", { id: "member", label: "负责人" }),
    createField("department", { id: "department", label: "部门" }),
  ];
  form.schema.fields = fields;
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-10",
  };
  form.versions = [form.published];
  const employee = data.organization.employees[0]!;
  data.organization.employees = [
    {
      ...employee,
      id: "person-a",
      name: "同名成员",
      number: "0001",
      departmentIds: ["dept-a"],
      primaryDepartmentId: "dept-a",
    },
    {
      ...employee,
      id: "0001",
      name: "同名成员",
      number: "0002",
      departmentIds: ["dept-b"],
      primaryDepartmentId: "dept-b",
    },
    {
      ...employee,
      id: "person-comma",
      name: "姓,名",
      number: "0003",
      departmentIds: ["dept-a"],
      primaryDepartmentId: "dept-a",
    },
    {
      ...employee,
      id: "person-hash",
      name: "名#称#",
      number: "0004",
      departmentIds: ["dept-a"],
      primaryDepartmentId: "dept-a",
    },
    {
      ...employee,
      id: "person-plain",
      name: "正常#姓名",
      number: "0005",
      departmentIds: ["dept-a"],
      primaryDepartmentId: "dept-a",
    },
  ];
  data.organization.departments = [
    {
      id: "dept-a",
      name: "同名部门",
      parentId: null,
      managerIds: [],
      archived: false,
    },
    {
      id: "dept-b",
      name: "同名部门",
      parentId: null,
      managerIds: [],
      archived: false,
    },
  ];
  function request(
    rows: RecordImportRequest["rows"],
    columns = fields,
  ): RecordImportRequest {
    return {
      mode: "create",
      definitionVersion: 1,
      rows,
      firstRow: 2,
      validate: false,
      triggerWorkflow: false,
      targets: [],
      mapping: columns.map((f, column) => ({
        fieldId: f.id,
        type: f.type,
        column,
      })),
    };
  }
  return { data, form, fields, request };
}
it("does not disguise rejected update inputs as the previous valid organization values", () => {
  const f = fixture();
  const entry: FormEntry = {
    id: "existing",
    formId: f.form.id,
    definitionVersion: 1,
    status: "submitted" as const,
    createdAt: "2026-10-10T00:00:00.000Z",
    history: [],
    values: { member: "person-a", department: "dept-a" },
  };
  f.data.entries = [entry];
  const before = copy(entry);
  const request: RecordImportRequest = {
    ...f.request([["existing", "找不到成员", "找不到部门"]]),
    mode: "update",
    mapping: [
      { column: 0, fieldId: "data_id", type: "data_id" },
      ...f.request([]).mapping.map((m) => ({ ...m, column: m.column + 1 })),
    ],
    targets: [
      { id: entry.id, definitionVersion: 1, values: copy(entry.values) },
    ],
  };
  const [failed] = prepareImportRows(f.form, request, f.data);
  expect(failed).toMatchObject({ kind: "error", id: "existing", values: {} });
  expect(failed!.issues!.map((i) => i.fieldId).sort()).toEqual([
    "department",
    "member",
  ]);
  expect(entry).toEqual(before);
  request.rows = [["existing", "#0002#", "#dept-b#"]];
  expect(
    prepareImportRows(f.form, { ...request, onlyRows: [0] }, f.data),
  ).toMatchObject([
    { kind: "update", values: { member: "0001", department: "dept-b" } },
  ]);
  expect(entry).toEqual(before);
});
it("uses wrapped employee numbers and department IDs to distinguish names, retaining bare legacy IDs", () => {
  const f = fixture();
  const rows = prepareImportRows(
    f.form,
    f.request([
      ["同名成员", "#dept-a#"],
      ["#0001#", "#dept-b#"],
      ["成员#0002#", "#dept-a#部门"],
      ["person-a", "dept-a"],
    ]),
    f.data,
  );
  expect(rows[0]!.kind).toBe("error");
  expect(rows[0]!.message).toContain("#工号#");
  expect(rows.slice(1).map((r) => r.values)).toEqual([
    { member: "person-a", department: "dept-b" },
    { member: "0001", department: "dept-a" },
    { member: "person-a", department: "dept-a" },
  ]);
  const departments = prepareImportRows(
    f.form,
    f.request([[null, "同名部门"]]),
    f.data,
  );
  expect(departments[0]!.message).toContain("#部门ID#");
});
it("keeps names with one hash literal and rejects missing or ambiguous identifiers", () => {
  const f = fixture();
  const rows = prepareImportRows(
    f.form,
    f.request([
      ["正常#姓名", "#dept-a#"],
      ["#missing#", "#dept-a#"],
      ["#0001#,#0002#", "#dept-a#"],
    ]),
    f.data,
  );
  expect(rows.map((r) => r.kind)).toEqual(["create", "error", "error"]);
  expect(rows[0]!.values!.member).toBe("person-plain");
  f.data.organization.employees[1]!.number = "0001";
  expect(
    prepareImportRows(f.form, f.request([["#0001#", "#dept-a#"]]), f.data)[0]!
      .kind,
  ).toBe("error");
});
it("does not let explicit identifiers bypass selectable ranges or inactive/archived status", () => {
  const f = fixture();
  f.form.published!.schema.fields[0]!.organization.scope = {
    mode: "custom",
    employeeIds: ["person-a"],
    departmentIds: [],
    roleIds: [],
    includeChildren: false,
    fieldId: "",
  };
  const rows = prepareImportRows(
    f.form,
    f.request([
      ["#0001#", "#dept-a#"],
      ["#0002#", "#dept-a#"],
    ]),
    f.data,
  );
  expect(rows.map((r) => r.kind)).toEqual(["create", "error"]);
  f.data.organization.employees[0]!.status = "inactive";
  expect(
    prepareImportRows(f.form, f.request([["#0001#", "#dept-a#"]]), f.data)[0]!
      .kind,
  ).toBe("error");
  f.data.organization.departments[0]!.archived = true;
  expect(
    prepareImportRows(f.form, f.request([[null, "#dept-a#"]]), f.data)[0]!.kind,
  ).toBe("error");
});
it("imports multiple identifiers in order and rejects selecting the same person twice", () => {
  const f = fixture();
  const fields = [
    createField("members", { id: "members" }),
    createField("departments", { id: "departments" }),
  ];
  f.form.published!.schema.fields = fields;
  const rows = prepareImportRows(
    f.form,
    f.request(
      [
        ["#0001#,#0002#", "#dept-b#,#dept-a#"],
        ["person-a,#0001#", "#dept-a#"],
      ],
      fields,
    ),
    f.data,
  );
  expect(rows[0]!.values).toEqual({
    members: ["person-a", "0001"],
    departments: ["dept-b", "dept-a"],
  });
  expect(rows[1]!.message).toContain("不能重复选择");
});
it("exports duplicate names and delimiter characters as identifiers through the shared formatter", () => {
  const f = fixture();
  const entry: FormEntry = {
    id: "entry",
    formId: f.form.id,
    definitionVersion: 1,
    values: { member: "person-a", department: "dept-b" },
    createdAt: "2026-10-10",
    status: "approved",
    history: [],
  };
  expect(
    f.fields.map((field) => importExcelValue(field, entry, f.data)),
  ).toEqual(["#0001#", "#dept-b#"]);
  for (const [id, text] of [
    ["person-comma", "#0003#"],
    ["person-hash", "#0004#"],
    ["person-plain", "#0005#"],
  ]) {
    entry.values.member = id!;
    expect(importExcelValue(f.fields[0]!, entry, f.data)).toBe(text);
  }
  f.data.organization.employees[0]!.name = "唯一成员";
  entry.values.member = "person-a";
  expect(importExcelValue(f.fields[0]!, entry, f.data)).toBe("唯一成员");
});
it("does not export ambiguous identifier delimiters as a misleading roundtrip file", () => {
  const f = fixture();
  const entry: FormEntry = {
    id: "entry",
    formId: f.form.id,
    definitionVersion: 1,
    values: { member: "person-a", members: ["person-a"] },
    createdAt: "2026-10-10",
    status: "approved",
    history: [],
  };
  f.data.organization.employees[0]!.number = "A,B";
  expect(importExcelValue(f.fields[0]!, entry, f.data)).toBe("#A,B#");
  expect(
    prepareImportRows(f.form, f.request([["#A,B#", null]]), f.data)[0]!.values!
      .member,
  ).toBe("person-a");
  expect(() =>
    importExcelValue(
      createField("members", { id: "members", label: "参与人" }),
      entry,
      f.data,
    ),
  ).toThrow("无法生成可导回");
  f.data.organization.employees[0]!.number = "A#B";
  expect(() => importExcelValue(f.fields[0]!, entry, f.data)).toThrow(
    "无法生成可导回",
  );
});
it("roundtrips main and merged subform organization selections through actual Excel bytes", async () => {
  const f = fixture();
  const parent = createField("subform", {
    id: "items",
    label: "参与部门",
    children: [
      createField("members", { id: "people" }),
      createField("departments", { id: "teams" }),
    ],
  });
  const schema = f.form.published!.schema;
  schema.fields.push(parent);
  const entry: FormEntry = {
    id: "entry",
    formId: f.form.id,
    definitionVersion: 1,
    createdAt: "2026-10-10",
    status: "approved",
    history: [],
    values: {
      member: "person-a",
      department: "dept-b",
      items: [
        { people: ["person-comma", "person-hash"], teams: ["dept-a"] },
        { people: ["0001"], teams: ["dept-b", "dept-a"] },
      ],
    },
  };
  const exported = recordExcelExport(
    f.data,
    schema.fields,
    [],
    [{ entry, schema, extra: [] }],
  );
  const bytes = await excelBytes(
    exported.rows,
    exported.fieldIds,
    exported.merges,
  );
  const sheet = (await readExcel(bytes, "组织字段.xlsx"))[0]!;
  const first = sheet.headerRow + 2;
  const columns: FormField[] = [...f.fields, ...parent.children];
  const request = f.request(sheet.rows.slice(first), columns);
  request.firstRow = first + 1;
  request.mapping.forEach((m, i) => {
    if (i >= 2) m.parentId = parent.id;
  });
  request.merges = sheet.merges
    ?.filter((m) => m.e.r >= first)
    .map((m) => ({
      s: { ...m.s, r: m.s.r - first },
      e: { ...m.e, r: m.e.r - first },
    }));
  const rows = prepareImportRows(f.form, request, f.data);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe("create");
  expect(rows[0]!.values).toEqual(entry.values);
});
