import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";
import { seedWorkspace } from "../src/domain/workspace";
import {
  WORKSPACE_KEY,
  LocalWorkspaceRepository,
} from "../src/repositories/workspaceRepository";
import {
  importRelationFields,
  recordImportColumns,
  prepareImportRows,
  importExcelValue,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import type { ExcelValue } from "../src/services/excel";
let memory: Map<string, string>,
  failSave = false;
beforeEach(() => {
  failSave = false;
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failSave) throw Error("quota");
      memory.set(k, v);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const store = useWorkspaceStore(createPinia());
  const source = (await store.createForm("oa", "客户信息", "form"))!;
  const sourceDraft = store.openForm(source.id)!;
  sourceDraft.schema.fields = [
    createField("text", { id: "clientName", label: "客户名称" }),
    createField("text", { id: "clientCode", label: "客户编号", unique: true }),
    createField("serial", {
      id: "clientSerial",
      serial: {
        digits: 3,
        initial: 1,
        fixed: true,
        reset: "none",
        rules: [{ id: "counter", type: "counter" }],
      },
    }),
    createField("phone", { id: "clientPhone" }),
    createField("select", {
      id: "clientChoice",
      options: [
        { id: "a", label: "旧甲" },
        { id: "b", label: "乙" },
      ],
    }),
    createField("radio", {
      id: "clientRadio",
      options: [{ id: "r", label: "旧档" }],
    }),
    createField("number", { id: "forbiddenNumber" }),
    createField("subform", {
      id: "sourceItems",
      children: [
        createField("text", { id: "forbiddenChild" }),
        createField("number"),
      ],
    }),
  ];
  expect(await store.publishForm(source.id)).toBe(true);
  const a = (await store.submitEntry(source.id, {
    clientName: "甲公司",
    clientCode: "C-A",
    clientPhone: "13800000001",
    clientChoice: "a",
    clientRadio: "r",
  }))!;
  const b = (await store.submitEntry(source.id, {
    clientName: "乙公司",
    clientCode: "C-B",
    clientChoice: "b",
  }))!;
  await store.submitEntry(source.id, {
    clientName: "重名",
    clientCode: "C-D1",
  });
  await store.submitEntry(source.id, {
    clientName: "重名",
    clientCode: "C-D2",
  });
  const draft = store.openForm(source.id)!;
  draft.schema.fields.find((f) => f.id === "clientChoice")!.options[0]!.label =
    "新甲";
  draft.schema.fields.find((f) => f.id === "clientRadio")!.options[0]!.label =
    "新档";
  expect(await store.publishForm(source.id)).toBe(true);
  const form = (await store.createForm("oa", "联系人", "form"))!;
  const target = store.openForm(form.id)!;
  const customer = createField("relation", {
    id: "customer",
    label: "关联客户",
    referenceFormId: source.id,
    referenceFieldId: "clientName",
  });
  customer.reference.mappings = [
    { sourceFieldId: "clientCode", targetFieldId: "filled" },
  ];
  target.schema.fields = [
    createField("text", { id: "person", label: "联系人" }),
    customer,
    createField("text", { id: "filled", defaultValue: "默认填充" }),
    createField("subform", {
      id: "items",
      label: "明细",
      children: [
        createField("relation", {
          id: "detailCustomer",
          label: "关联客户",
          referenceFormId: source.id,
        }),
        createField("number", { id: "qty", label: "数量" }),
      ],
    }),
  ];
  expect(await store.publishForm(form.id)).toBe(true);
  const live = () => store.data.forms.find((f) => f.id === form.id)!;
  const request = (
    rows: ExcelValue[][],
    ids = ["person", "customer"],
    options: Partial<RecordImportRequest> = {},
    key = "clientName",
  ): RecordImportRequest => {
    const columns = recordImportColumns(live().published!.schema);
    return {
      mode: "create",
      definitionVersion: live().published!.version,
      rows,
      firstRow: 2,
      validate: false,
      triggerWorkflow: false,
      targets: [],
      mapping: ids.map((id, column) => {
        if (id === "data_id") return { column, fieldId: id, type: "data_id" };
        const field = columns.find((c) => c.field.id === id)!;
        return {
          column,
          fieldId: id,
          type: field.field.type,
          ...(field.parent ? { parentId: field.parent.id } : {}),
          ...(field.field.type === "relation" ? { matchFieldId: key } : {}),
        };
      }),
      ...options,
    };
  };
  return { store, source, form: live(), a, b, live, request };
}
it("serializes corrected relation choices with the selected historical source key", async () => {
  const f = await fixture();
  const field = f.form.published!.schema.fields.find(
    (f) => f.id === "customer",
  )!;
  const record = { values: { customer: f.a.id } };
  expect(importExcelValue(field, record, f.store.data)).toBe("甲公司");
  expect(importExcelValue(field, record, f.store.data, "clientCode")).toBe(
    "C-A",
  );
  expect(importExcelValue(field, record, f.store.data, "clientChoice")).toBe(
    "旧甲",
  );
  expect(() =>
    importExcelValue(field, record, f.store.data, "forbiddenNumber"),
  ).toThrow("匹配字段不可用");
  expect(() =>
    importExcelValue(
      field,
      record,
      { ...f.store.data, entries: [] },
      "clientCode",
    ),
  ).toThrow("关联记录不可用");
});
it("uses published main scalar keys and requires an explicit key without admitting query/lookup/reverse fields", async () => {
  const f = await fixture();
  const relation = f.form.published!.schema.fields.find(
    (f) => f.id === "customer",
  )!;
  const sourceDraft = f.store.openForm(f.source.id)!;
  sourceDraft.schema.fields.push(createField("text", { id: "unpublished" }));
  expect(importRelationFields(relation, f.store.data).map((f) => f.id)).toEqual(
    [
      "clientName",
      "clientCode",
      "clientSerial",
      "clientPhone",
      "clientChoice",
      "clientRadio",
    ],
  );
  for (const key of ["", "forbiddenNumber", "forbiddenChild", "unpublished"])
    expect(() =>
      prepareImportRows(
        f.form,
        f.request([["甲", "甲公司"]], undefined, {}, key),
        f.store.data,
      ),
    ).toThrow("主表匹配字段");
  const schema = copy(f.form.published!.schema);
  schema.fields.push(createField("lookup"), createField("query"), {
    ...copy(relation),
    id: "reverse",
    reference: { ...relation.reference, mode: "reverse" },
  });
  expect(
    recordImportColumns(schema).some(
      (c) =>
        ["lookup", "query"].includes(c.field.type) || c.field.id === "reverse",
    ),
  ).toBe(false);
});
it("links only a unique exact key, reports missing/duplicate rows even without optional validation and skips autofill", async () => {
  const f = await fixture();
  const result = await f.store.importEntries(
    f.form.id,
    f.request([
      ["甲联系人", "甲公司"],
      ["无对应", "不存在"],
      ["有重名", "重名"],
      ["空白", ""],
      ["空格不同", "甲公司 "],
    ]),
  );
  expect(result && result.created).toBe(2);
  expect(result && result.rows[1]!.message).toContain("未在主表找到");
  expect(result && result.rows[2]!.message).toContain("多条主表数据");
  expect(result && result.rows[4]!.kind).toBe("error");
  const entries = new LocalWorkspaceRepository()
    .load()!
    .entries.filter((e) => e.formId === f.form.id);
  expect(entries.find((e) => e.values.person === "甲联系人")!.values).toEqual({
    person: "甲联系人",
    customer: f.a.id,
  });
  expect(entries.find((e) => e.values.person === "空白")!.values.customer).toBe(
    "",
  );
});
it("matches codes, serials, phones and exact historical choice labels rather than current draft labels", async () => {
  const f = await fixture();
  for (const [key, input] of [
    ["clientCode", "C-A"],
    ["clientSerial", String(f.a.values.clientSerial)],
    ["clientPhone", "13800000001"],
    ["clientChoice", "旧甲"],
    ["clientRadio", "旧档"],
  ]) {
    const result = prepareImportRows(
      f.form,
      f.request([[key, input!]], undefined, {}, key),
      f.store.data,
    );
    expect(result[0]!.values?.customer).toBe(f.a.id);
  }
  expect(
    prepareImportRows(
      f.form,
      f.request([["新标签", "新甲"]], undefined, {}, "clientChoice"),
      f.store.data,
    )[0]!.kind,
  ).toBe("error");
});
it("updates an existing link atomically, retains empty inputs and cannot use raw IDs to bypass the chosen key", async () => {
  const f = await fixture();
  await f.store.importEntries(f.form.id, f.request([["联系人", "甲公司"]]));
  const entry = copy(f.store.data.entries.find((e) => e.formId === f.form.id)!);
  const result = await f.store.importEntries(
    f.form.id,
    f.request(
      [
        [entry.id, "乙公司"],
        [entry.id, ""],
      ],
      ["data_id", "customer"],
      { mode: "both", targets: [entry] },
    ),
  );
  expect(result && result.updated).toBe(2);
  expect(
    f.store.data.entries.find((e) => e.id === entry.id)!.values.customer,
  ).toBe(f.b.id);
  const raw = prepareImportRows(
    f.live(),
    f.request([["伪造", f.a.id]]),
    f.store.data,
  );
  expect(raw[0]!.kind).toBe("error");
});
it("does not offer unsupported child associations or accept a forged child binding", async () => {
  const f = await fixture();
  expect(
    recordImportColumns(f.form.published!.schema).some(
      (c) => c.field.id === "detailCustomer",
    ),
  ).toBe(false);
  const request = f.request([["联系人"]], ["person"]);
  request.mapping.push({
    column: 1,
    fieldId: "detailCustomer",
    parentId: "items",
    type: "relation",
    matchFieldId: "clientName",
  });
  expect(() => prepareImportRows(f.form, request, f.store.data)).toThrow(
    "匹配字段",
  );
});
it("rejects self association while allowing another record in the same table", async () => {
  const f = await fixture();
  f.store.openForm(f.source.id)!.schema.fields.push(
    createField("relation", {
      id: "parent",
      label: "上级客户",
      referenceFormId: f.source.id,
    }),
  );
  expect(await f.store.publishForm(f.source.id)).toBe(true);
  const entry = (await f.store.submitEntry(f.source.id, {
    clientName: "当前客户",
    clientCode: "C-SELF",
  }))!;
  const form = f.store.data.forms.find((form) => form.id === f.source.id)!;
  const request: RecordImportRequest = {
    mode: "update",
    definitionVersion: form.published!.version,
    rows: [[entry.id, "当前客户"]],
    firstRow: 2,
    validate: false,
    triggerWorkflow: false,
    targets: [copy(entry)],
    mapping: [
      { column: 0, fieldId: "data_id", type: "data_id" },
      {
        column: 1,
        fieldId: "parent",
        type: "relation",
        matchFieldId: "clientName",
      },
    ],
  };
  const result = await f.store.importEntries(form.id, request);
  expect(result && result.updated).toBe(0);
  expect(result && result.rows[0]!.message).toContain("自身");
  expect(f.store.data.entries.find((e) => e.id === entry.id)!.values).toEqual(
    entry.values,
  );
  request.rows = [[entry.id, "甲公司"]];
  expect(
    (await f.store.importEntries(form.id, request)) &&
      f.store.data.entries.find((e) => e.id === entry.id)!.values.parent,
  ).toBe(f.a.id);
});
it("does not apply a new master table's matches to an older record definition", async () => {
  const f = await fixture();
  await f.store.importEntries(f.form.id, f.request([["联系人", "甲公司"]]));
  const entry = copy(f.store.data.entries.find((e) => e.formId === f.form.id)!);
  const other = (await f.store.createForm("oa", "另一客户主表", "form"))!;
  f.store.openForm(other.id)!.schema.fields = [
    createField("text", { id: "clientName", label: "客户名称" }),
    createField("text", { id: "clientCode", label: "客户编号" }),
  ];
  expect(await f.store.publishForm(other.id)).toBe(true);
  await f.store.submitEntry(other.id, { clientName: "乙公司" });
  f.store
    .openForm(f.form.id)!
    .schema.fields.find((field) => field.id === "customer")!.referenceFormId =
    other.id;
  expect(
    await f.store.publishForm(f.form.id),
    JSON.stringify(f.store.notices),
  ).toBe(true);
  const result = await f.store.importEntries(
    f.form.id,
    f.request([[entry.id, "乙公司"]], ["data_id", "customer"], {
      mode: "update",
      targets: [entry],
    }),
  );
  expect(result && result.updated).toBe(0);
  expect(result && result.rows[0]!.message).toContain("原版本的关联主表");
  expect(
    f.store.data.entries.find((e) => e.id === entry.id)!.values.customer,
  ).toBe(f.a.id);
  const unrelated = await f.store.importEntries(
    f.form.id,
    f.request([[entry.id, "改姓名", ""]], ["data_id", "person", "customer"], {
      mode: "update",
      targets: [entry],
    }),
  );
  expect(unrelated && unrelated.updated).toBe(1);
  expect(
    f.store.data.entries.find((e) => e.id === entry.id)!.values,
  ).toMatchObject({ person: "改姓名", customer: f.a.id });
});
it("rechecks committed source rows under the shared lock and rolls back linked rows on a failed save", async () => {
  const f = await fixture();
  expect(
    prepareImportRows(
      f.form,
      f.request([["联系人", "甲公司"]]),
      f.store.data,
    )[0]!.kind,
  ).toBe("create");
  const other = useWorkspaceStore(createPinia());
  await other.submitEntry(f.source.id, {
    clientName: "甲公司",
    clientCode: "C-NEW",
  });
  const result = await f.store.importEntries(
    f.form.id,
    f.request([["联系人", "甲公司"]]),
  );
  expect(result && result.created).toBe(0);
  expect(result && result.rows[0]!.message).toContain("多条主表数据");
  failSave = true;
  expect(
    await f.store.importEntries(
      f.form.id,
      f.request([["联系人", "C-B"]], undefined, {}, "clientCode"),
    ),
  ).toBe(false);
  expect(f.store.data.entries.some((e) => e.formId === f.form.id)).toBe(false);
  expect(
    new LocalWorkspaceRepository()
      .load()!
      .entries.some((e) => e.formId === f.form.id),
  ).toBe(false);
});
it("exports the linked record's historical title and rejects broken, draft, archived or unknown-version targets", async () => {
  const f = await fixture();
  await f.store.importEntries(f.form.id, f.request([["联系人", "甲公司"]]));
  const entry = f.store.data.entries.find((e) => e.formId === f.form.id)!;
  const field = f.form.published!.schema.fields.find(
    (f) => f.id === "customer",
  )!;
  f.store.openForm(f.source.id)!.schema.fields[0]!.label = "草稿标题";
  expect(importExcelValue(field, entry, f.store.data)).toBe("甲公司");
  const related = f.store.data.entries.find((e) => e.id === f.a.id)!;
  for (const change of [
    { deletedAt: "2026-10-10" },
    { status: "draft" as const },
    { definitionVersion: 999 },
  ]) {
    const data = copy(f.store.data);
    Object.assign(
      data.entries.find((e) => e.id === related.id)!,
      change,
    );
    expect(() => importExcelValue(field, entry, data)).toThrow(
      "关联记录不可用",
    );
  }
  const data = copy(f.store.data);
  data.forms.find((form) => form.id === f.source.id)!.archived = true;
  expect(() => importExcelValue(field, entry, data)).toThrow("关联记录不可用");
});
