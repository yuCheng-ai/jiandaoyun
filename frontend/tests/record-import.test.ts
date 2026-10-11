import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy, createField, type FormField } from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";
import { seedWorkspace, type FormEntry } from "../src/domain/workspace";
import { newWebhook } from "../src/domain/extensions";
import {
  prepareImportRows,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import type { ExcelValue } from "../src/services/excel";
let memory: Map<string, string>,
  failSave = false;
beforeEach(() => {
  failSave = false;
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failSave) throw Error("quota");
      memory.set(key, value);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
const saved = () => new LocalWorkspaceRepository().load()!;
async function setup(kind: "form" | "workflow" = "form") {
  const store = useWorkspaceStore(createPinia()),
    form = (await store.createForm("oa", "导入测试", kind))!,
    draft = store.openForm(form.id)!;
  draft.schema.fields = [
    createField("text", { id: "code", label: "编号", unique: true }),
    createField("text", { id: "required", label: "必填", required: true }),
    createField("number", { id: "quantity", label: "数量", min: 0, max: 10 }),
    createField("number", { id: "default", defaultValue: 9 }),
    createField("calculated", { id: "total", expression: "{{quantity}} * 2" }),
    createField("serial", {
      id: "serial",
      serial: {
        digits: 4,
        fixed: true,
        reset: "none",
        initial: 1,
        rules: [
          { id: "prefix", type: "text", value: "IM-" },
          { id: "count", type: "counter" },
        ],
      },
    }),
    createField("select", {
      id: "choice",
      options: [
        { id: "a", label: "甲" },
        { id: "b", label: "乙" },
      ],
    }),
    createField("datetime", { id: "date", format: "datetime-second" }),
    createField("phone", { id: "phone" }),
    createField("text", { id: "email", format: "email" }),
  ];
  const credential = (await store.createWebhookCredential())!,
    webhook = newWebhook();
  Object.assign(webhook, {
    name: "导入事件验证",
    url: "https://example.com/hooks",
    credentialRef: credential.id,
    events: ["data_create", "data_update"],
    fieldIds: ["quantity"],
    enabled: true,
  });
  expect(await store.saveWebhook(form.id, webhook)).toBeTruthy();
  expect(await store.publishForm(form.id)).toBe(true);
  const a = (await store.submitEntry(form.id, {
      code: "A",
      required: "保留",
      quantity: 2,
      choice: "a",
    }))!,
    b = (await store.submitEntry(form.id, {
      code: "B",
      required: "保留",
      quantity: 3,
      choice: "a",
    }))!;
  const request = (
    rows: ExcelValue[][],
    fields: string[],
    options: Partial<RecordImportRequest> = {},
  ): RecordImportRequest => ({
    mode: "create",
    definitionVersion: store.data.forms.find((f) => f.id === form.id)!
      .published!.version,
    rows,
    firstRow: 2,
    validate: false,
    triggerWorkflow: false,
    mapping: fields.map((fieldId, column) => ({
      column,
      fieldId,
      type:
        fieldId === "data_id"
          ? "data_id"
          : store.data.forms
              .find((f) => f.id === form.id)!
              .published!.schema.fields.find((f) => f.id === fieldId)!.type,
    })),
    targets: [a, b].map(({ id, definitionVersion, values }) => ({
      id,
      definitionVersion,
      values: copy(values),
    })),
    ...options,
  });
  return {
    store,
    form: store.data.forms.find((f) => f.id === form.id)!,
    draft,
    a,
    b,
    request,
  };
}
it("creates without defaults, required/form checks, formulas or data events when admin validation is off", async () => {
  const { store, form, request } = await setup(),
    before = copy(store.data);
  const result = await store.importEntries(
    form.id,
    request(
      [
        ["C", 0, "传入编号"],
        ["A", 1, "忽略"],
        ["D", -8, "忽略"],
      ],
      ["code", "quantity", "serial"],
    ),
  );
  expect(result).toMatchObject({ created: 3, updated: 0 });
  const c = store.data.entries.find((e) => e.values.code === "C")!,
    d = store.data.entries.find((e) => e.values.code === "D")!;
  expect(c.values).toEqual({ code: "C", quantity: 0, serial: "IM-0003" });
  expect(d.values).toEqual({ code: "D", quantity: -8, serial: "IM-0005" });
  expect(store.data.entries.filter((e) => e.values.code === "A")).toHaveLength(
    2,
  );
  expect(c.createdBy).toBe(store.data.organization.currentUserId);
  expect(c.definitionVersion).toBe(1);
  expect(store.data.serialCounters?.[form.id]?.serial?.none?.next).toBe(6);
  expect(store.data.extensionRuns).toEqual(before.extensionRuns);
  expect(c.history.at(-1)?.action).toBe("导入新增");
  expect(saved().entries).toHaveLength(5);
});
it("collects cell issues without writing partial values and retries only failed rows against committed uniqueness", async () => {
  const { store, form, request } = await setup();
  const input = request(
    [
      ["A", -1, "未知", "bad"],
      ["C", 2, "甲", "a@example.com"],
    ],
    ["code", "quantity", "choice", "email"],
    { validate: true },
  );
  const result = await store.importEntries(form.id, input);
  expect(result).toMatchObject({ created: 1, updated: 0 });
  if (!result) throw Error("import failed");
  expect(result.rows[0]).toMatchObject({
    kind: "error",
    row: 2,
    values: { code: "A", quantity: -1, email: "bad" },
  });
  expect(result.rows[0]!.issues!.map((i) => i.fieldId).sort()).toEqual([
    "choice",
    "code",
    "email",
    "quantity",
  ]);
  expect(result.rows[0]!.issues!.every((i) => i.row === 2)).toBe(true);
  const c = copy(store.data.entries.find((e) => e.values.code === "C")!);
  expect(c.values.serial).toBe("IM-0003");
  expect(store.data.entries).toHaveLength(3);
  input.onlyRows = [0];
  input.rows[0] = ["C", 0, "乙", "b@example.com"];
  expect(prepareImportRows(form, input, store.data)).toMatchObject([
    { row: 2, kind: "error", message: "编号不能重复" },
  ]);
  input.rows[0]![0] = "D";
  const retried = await store.importEntries(form.id, input);
  expect(retried).toMatchObject({
    created: 1,
    updated: 0,
    rows: [{ row: 2, kind: "create" }],
  });
  expect(retried && retried.rows).toHaveLength(1);
  expect(store.data.entries.find((e) => e.id === c.id)).toEqual(c);
  expect(
    store.data.entries.find((e) => e.values.code === "D")!.values,
  ).toMatchObject({ quantity: 0, choice: "b", serial: "IM-0004" });
  expect(saved().entries).toHaveLength(4);
  expect(store.data.serialCounters?.[form.id]?.serial?.none?.next).toBe(5);
});
it("rejects empty, repeated or invalid retry row selections", async () => {
  const { store, form, request } = await setup();
  for (const onlyRows of [[], [0, 0], [-1], [0.5], [2]]) {
    expect(() =>
      prepareImportRows(
        form,
        request([["C"], ["D"]], ["code"], { onlyRows }),
        store.data,
      ),
    ).toThrow("完整的失败数据");
  }
});
it("update-only uses IDs, retains blank fields, writes numeric zero, skips unknown IDs and duplicate rows after the first", async () => {
  const { store, form, a, b, request } = await setup(),
    counters = copy(store.data.serialCounters);
  const result = await store.importEntries(
    form.id,
    request(
      [
        [a.id, 0, ""],
        [a.id, 8, "重复"],
        ["unknown", 9, "未知"],
        [null, 10, "新增"],
      ],
      ["data_id", "quantity", "required"],
      { mode: "update" },
    ),
  );
  expect(result).toMatchObject({ created: 0, updated: 1 });
  expect(a.values.quantity).toBe(0);
  expect(a.values.required).toBe("保留");
  expect(a.values.total).toBe(4);
  expect(b.values.quantity).toBe(3);
  expect(store.data.entries).toHaveLength(2);
  expect(store.data.serialCounters).toEqual(counters);
  expect(a.history.at(-1)?.action).toContain("Excel 第 2 行");
  expect(result && result.rows.filter((r) => r.kind === "skip")).toHaveLength(
    3,
  );
});
it("mixed mode updates duplicate IDs in row order, uses the last successful value and creates only empty IDs", async () => {
  const { store, form, a, request } = await setup();
  const result = await store.importEntries(
    form.id,
    request(
      [
        [a.id, "", 5, ""],
        [a.id, "", 7, "手工编号"],
        [null, "C", 0, "忽略"],
        ["unknown", "X", 9, "未知"],
      ],
      ["data_id", "code", "quantity", "serial"],
      { mode: "both" },
    ),
  );
  expect(result).toMatchObject({ created: 1, updated: 2 });
  expect(a.values).toMatchObject({
    code: "A",
    quantity: 7,
    serial: "手工编号",
    total: 4,
  });
  expect(
    store.data.entries.find((e) => e.values.code === "C")?.values.serial,
  ).toBe("IM-0003");
  expect(store.data.entries).toHaveLength(3);
});
it("makes optional validation effective without treating required fields as a form submission", async () => {
  const { store, form, request } = await setup();
  const result = await store.importEntries(
    form.id,
    request(
      [
        ["C", -1, "乙", "bad"],
        ["D", 2, "甲", "a@example.com"],
        ["E", 3, "未知", "a@example.com"],
      ],
      ["code", "quantity", "choice", "email"],
      { validate: true },
    ),
  );
  expect(result).toMatchObject({ created: 1 });
  expect(
    store.data.entries.find((e) => e.values.code === "D")?.values.choice,
  ).toBe("a");
  expect(result && result.rows.filter((r) => r.kind === "error")).toHaveLength(
    2,
  );
  expect(
    await store.importEntries(
      form.id,
      request(
        [["F", -1, "未列出的选项", "bad"]],
        ["code", "quantity", "choice", "email"],
      ),
    ),
  ).toMatchObject({ created: 1 });
});
it("clears invalid number/date/phone content with a report, but blank update cells retain the original", async () => {
  const { store, form, request, a } = await setup();
  const result = await store.importEntries(
    form.id,
    request(
      [
        ["C", "bad", "2026/2/30", "bad"],
        ["D", 0, "2026年2月28日 8:5:3", "13812345678"],
      ],
      ["code", "quantity", "date", "phone"],
      { validate: true },
    ),
  );
  expect(result).toMatchObject({ created: 2 });
  expect(
    store.data.entries.find((e) => e.values.code === "C")?.values,
  ).toMatchObject({ quantity: null, date: "", phone: "" });
  expect(
    store.data.entries.find((e) => e.values.code === "D")?.values.date,
  ).toBe("2026-02-28T08:05:03");
  expect(result && result.rows[0]?.warnings).toHaveLength(3);
  expect(
    await store.importEntries(
      form.id,
      request([[a.id, "bad"]], ["data_id", "quantity"], { mode: "update" }),
    ),
  ).toMatchObject({ updated: 1 });
  expect(a.values.quantity).toBeNull();
});
it("checks uniqueness against current records and earlier successful file rows, without losing valid rows", async () => {
  const { store, form, request } = await setup();
  const result = await store.importEntries(
    form.id,
    request(
      [
        ["A", 1],
        ["C", 0],
        ["C", 2],
        ["D", 3],
      ],
      ["code", "quantity"],
      { validate: true },
    ),
  );
  expect(result).toMatchObject({ created: 2 });
  expect(result && result.rows.map((r) => r.kind)).toEqual([
    "error",
    "create",
    "error",
    "create",
  ]);
  expect(
    store.data.entries.find((e) => e.values.code === "C")?.values.serial,
  ).toBe("IM-0003");
  expect(
    store.data.entries.find((e) => e.values.code === "D")?.values.serial,
  ).toBe("IM-0004");
  expect(store.data.serialCounters?.[form.id]?.serial?.none?.next).toBe(5);
});
it("lets admins import both existing and in-file duplicate values when validation is off", async () => {
  const { store, form, request } = await setup();
  const result = await store.importEntries(
    form.id,
    request(
      [
        ["A", 0],
        ["A", 1],
      ],
      ["code", "quantity"],
    ),
  );
  expect(result).toMatchObject({ created: 2, updated: 0 });
  expect(result && result.rows.map((r) => r.kind)).toEqual([
    "create",
    "create",
  ]);
  expect(saved().entries.filter((e) => e.values.code === "A")).toHaveLength(3);
});
it("applies the validation switch to update and mixed modes while keeping ID handling independent", async () => {
  const { store, form, a, request } = await setup();
  expect(
    await store.importEntries(
      form.id,
      request([[a.id, "B"]], ["data_id", "code"], {
        mode: "update",
        validate: true,
      }),
    ),
  ).toMatchObject({ updated: 0 });
  expect(a.values.code).toBe("A");
  expect(
    await store.importEntries(
      form.id,
      request(
        [
          [a.id, "B"],
          [a.id, "C"],
        ],
        ["data_id", "code"],
        { mode: "update" },
      ),
    ),
  ).toMatchObject({ updated: 1 });
  expect(a.values.code).toBe("B");
  const checked = request(
    [
      [a.id, "C"],
      [a.id, "A"],
      [null, "C"],
      [null, "A"],
    ],
    ["data_id", "code"],
    { mode: "both", validate: true },
  );
  const result = await store.importEntries(form.id, checked);
  expect(result).toMatchObject({ updated: 2, created: 1 });
  expect(result && result.rows.map((r) => r.kind)).toEqual([
    "update",
    "update",
    "create",
    "error",
  ]);
  expect(a.values.code).toBe("A");
  expect(
    await store.importEntries(
      form.id,
      request(
        [
          [a.id, "B"],
          [null, "B"],
          ["unknown", "B"],
        ],
        ["data_id", "code"],
        { mode: "both" },
      ),
    ),
  ).toMatchObject({ updated: 1, created: 1 });
  expect(saved().entries.filter((e) => e.values.code === "B")).toHaveLength(3);
});
it("rolls back records, audit and serial counters together on persistence failure", async () => {
  const { store, form, a, request } = await setup(),
    before = copy(store.data);
  const input = request(
    [
      [a.id, "", 9],
      [null, "C", 0],
    ],
    ["data_id", "code", "quantity"],
    { mode: "both" },
  );
  failSave = true;
  expect(await store.importEntries(form.id, input)).toBe(false);
  expect(store.data.entries).toEqual(before.entries);
  expect(store.data.serialCounters).toEqual(before.serialCounters);
  expect(store.data.extensionRuns).toEqual(before.extensionRuns);
  failSave = false;
  expect(await store.importEntries(form.id, input)).toMatchObject({
    created: 1,
    updated: 1,
  });
  expect(
    saved().entries.find((e) => e.values.code === "C")?.values.serial,
  ).toBe("IM-0003");
});
it("rejects affected-record conflicts and retains independent writes from another page", async () => {
  const { store, form, a, b, request } = await setup(),
    input = request([[a.id, 5]], ["data_id", "quantity"], { mode: "update" }),
    other = useWorkspaceStore(createPinia());
  expect(
    await other.batchUpdateEntries(
      form.id,
      [
        {
          id: b.id,
          definitionVersion: b.definitionVersion,
          values: copy(b.values),
        },
      ],
      { fieldId: "quantity", mode: "fixed", value: 8 },
    ),
  ).toBe(true);
  expect(await store.importEntries(form.id, input)).toMatchObject({
    updated: 1,
  });
  expect(saved().entries.find((e) => e.id === b.id)?.values.quantity).toBe(8);
  const stale = request([[a.id, 6]], ["data_id", "quantity"], {
    mode: "update",
  });
  const latest = useWorkspaceStore(createPinia()),
    current = latest.data.entries.find((e) => e.id === a.id)!;
  expect(
    await latest.batchUpdateEntries(
      form.id,
      [{ id: current.id, definitionVersion: 1, values: copy(current.values) }],
      { fieldId: "quantity", mode: "fixed", value: 9 },
    ),
  ).toBe(true);
  expect(await store.importEntries(form.id, stale)).toBe(false);
  expect(saved().entries.find((e) => e.id === a.id)?.values.quantity).toBe(9);
});
it("keeps historical definitions pinned and rejects incompatible fields instead of upgrading records", async () => {
  const { store, form, draft, a, request } = await setup(),
    stale = request([["C", 0]], ["code", "quantity"]);
  draft.schema.fields.find((f) => f.id === "quantity")!.type = "text";
  draft.schema.fields.find((f) => f.id === "quantity")!.format = "none";
  draft.schema.fields.find((f) => f.id === "total")!.expression =
    "LEN({{quantity}})";
  expect(await store.publishForm(form.id)).toBe(true);
  expect(await store.importEntries(form.id, stale)).toBe(false);
  const current = request([[a.id, "new"]], ["data_id", "quantity"], {
    mode: "update",
  });
  expect(await store.importEntries(form.id, current)).toMatchObject({
    updated: 0,
  });
  expect(a.values.quantity).toBe(2);
  expect(a.definitionVersion).toBe(1);
  expect(a.values.total).toBe(4);
  expect(
    await store.importEntries(
      form.id,
      request([[a.id, "改编号"]], ["data_id", "code"], { mode: "update" }),
    ),
  ).toMatchObject({ updated: 1 });
  expect(a.definitionVersion).toBe(1);
});
it("starts only newly imported workflow records when explicitly checked, with the existing engine", async () => {
  const { store, form, request } = await setup("workflow");
  expect(
    await store.importEntries(
      form.id,
      request([["C", 0]], ["code", "quantity"]),
    ),
  ).toMatchObject({ created: 1 });
  const c = store.data.entries.find((e) => e.values.code === "C")!;
  expect(c.status).toBe("approved");
  expect(c.currentNodeId).toBeUndefined();
  expect(
    await store.importEntries(
      form.id,
      request([["D", 0]], ["code", "quantity"], { triggerWorkflow: true }),
    ),
  ).toMatchObject({ created: 1 });
  const d = store.data.entries.find((e) => e.values.code === "D")!;
  expect(d.status).toBe("submitted");
  expect(d.currentNodeId).toBeTruthy();
  const before = copy(store.data.entries);
  expect(
    await store.importEntries(
      form.id,
      request(
        Array.from({ length: 301 }, (_, i) => ["N" + i, 0]),
        ["code", "quantity"],
        { triggerWorkflow: true },
      ),
    ),
  ).toBe(false);
  expect(store.data.entries).toEqual(before);
});
it("matches organization names uniquely within scope and accepts explicit IDs for duplicate names", async () => {
  const { store, form, draft, request } = await setup();
  draft.schema.fields.push(
    createField("member", { id: "member" }),
    createField("department", { id: "department" }),
  );
  expect(await store.publishForm(form.id)).toBe(true);
  const employee = store.data.organization.employees.find(
      (e) => e.status === "active",
    )!,
    department = store.data.organization.departments.find((d) => !d.archived)!;
  const result = await store.importEntries(
    form.id,
    request(
      [
        ["C", employee.name, department.name],
        ["D", "不存在", department.name],
      ],
      ["code", "member", "department"],
    ),
  );
  expect(result).toMatchObject({ created: 1 });
  expect(
    store.data.entries.find((e) => e.values.code === "C")?.values,
  ).toMatchObject({ member: employee.id, department: department.id });
});
it("does not allow malformed mappings and prepares a large unique file without repeated full-record scans", async () => {
  const { store, form, request } = await setup();
  expect(
    await store.importEntries(
      form.id,
      request([[0]], ["quantity"], { mode: "update" }),
    ),
  ).toBe(false);
  const malformed = request([[0]], ["quantity"]);
  malformed.mapping.push({ column: 0, fieldId: "quantity", type: "number" });
  expect(await store.importEntries(form.id, malformed)).toBe(false);
  const rows = prepareImportRows(
    form,
    request(
      Array.from({ length: 10000 }, (_, i) => ["N" + i, 0]),
      ["code", "quantity"],
      { validate: true },
    ),
    store.data,
  );
  expect(rows.filter((r) => r.kind === "create")).toHaveLength(10000);
});
