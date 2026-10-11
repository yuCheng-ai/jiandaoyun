import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";
import { seedWorkspace, type FormEntry } from "../src/domain/workspace";
import { newWebhook } from "../src/domain/extensions";

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
const selection = (entries: FormEntry[]) =>
  entries.map(({ id, values, definitionVersion }) => ({
    id,
    values: copy(values),
    definitionVersion,
  }));
async function setup() {
  const store = useWorkspaceStore(createPinia()),
    form = (await store.createForm("oa", "批改测试", "form"))!,
    draft = store.openForm(form.id)!;
  draft.schema.fields = [
    createField("text", { id: "code", required: true, unique: true }),
    createField("text", { id: "required", required: true }),
    createField("number", { id: "quantity", min: 0, max: 10 }),
    createField("calculated", { id: "total", expression: "{{quantity}} * 2" }),
    createField("serial", { id: "serial" }),
    createField("select", {
      id: "choice",
      options: [
        { id: "a", label: "甲" },
        { id: "b", label: "乙" },
      ],
    }),
    createField("subform", {
      id: "rows",
      children: [
        createField("number", { id: "amount" }),
        createField("text", { id: "note" }),
      ],
    }),
  ];
  const credential = (await store.createWebhookCredential())!,
    webhook = newWebhook();
  Object.assign(webhook, {
    name: "批改事件验证",
    url: "https://example.com/hooks",
    credentialRef: credential.id,
    events: ["data_update"],
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
      rows: [
        { amount: 1, note: "一" },
        { amount: 0, note: "二" },
      ],
    }))!,
    b = (await store.submitEntry(form.id, {
      code: "B",
      required: "保留",
      quantity: 3,
      choice: "a",
      rows: [{ amount: 2, note: "三" }],
    }))!;
  return { store, form, draft, a, b };
}
it("batch edits only the selected column, without validation, dependent calculations, events or counting", async () => {
  const { store, form, a, b } = await setup(),
    before = copy(store.data),
    chosen = selection([a, b]);
  expect(
    await store.batchUpdateEntries(form.id, chosen, {
      fieldId: "quantity",
      mode: "fixed",
      value: -9,
    }),
  ).toBe(true);
  expect([a.values.quantity, b.values.quantity]).toEqual([-9, -9]);
  expect([a.values.total, b.values.total]).toEqual([4, 6]);
  expect(store.data.serialCounters).toEqual(before.serialCounters);
  expect(store.data.extensionRuns).toEqual(before.extensionRuns);
  expect(a.history.at(-1)?.action).toContain("批量修改");
  expect(a.currentNodeId).toBe(
    before.entries.find((e) => e.id === a.id)?.currentNodeId,
  );
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "required",
      mode: "empty",
    }),
  ).toBe(true);
  expect([a.values.required, b.values.required]).toEqual(["", ""]);
  expect(saved().entries.find((e) => e.id === a.id)?.values.quantity).toBe(-9);
});
it("evaluates current-field expressions against each original record and retains zero serial results", async () => {
  const { store, form, a, b } = await setup(),
    counters = copy(store.data.serialCounters);
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "quantity",
      mode: "formula",
      expression: "{{quantity}} * 1.1",
    }),
  ).toBe(true);
  expect([a.values.quantity, b.values.quantity]).toEqual([
    2.2, 3.3000000000000003,
  ]);
  expect([a.values.total, b.values.total]).toEqual([4, 6]);
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "serial",
      mode: "formula",
      expression: 'CONCATENATE({{code}}, "-", 0)',
    }),
  ).toBe(true);
  expect([a.values.serial, b.values.serial]).toEqual(["A-0", "B-0"]);
  expect(
    await store.batchUpdateEntries(form.id, selection([a]), {
      fieldId: "serial",
      mode: "fixed",
      value: "0",
    }),
  ).toBe(true);
  expect(a.values.serial).toBe("0");
  expect(
    await store.batchUpdateEntries(form.id, selection([a]), {
      fieldId: "serial",
      mode: "empty",
    }),
  ).toBe(true);
  expect(a.values.serial).toBe("");
  expect(store.data.serialCounters).toEqual(counters);
});
it("edits each existing subform row using its own old values and main fields, preserving rows and unrelated columns", async () => {
  const { store, form, a, b } = await setup();
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "amount",
      mode: "formula",
      expression: "{{amount}} + {{quantity}}",
    }),
  ).toBe(true);
  expect(a.values.rows).toEqual([
    { amount: 3, note: "一" },
    { amount: 2, note: "二" },
  ]);
  expect(b.values.rows).toEqual([{ amount: 5, note: "三" }]);
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "note",
      mode: "empty",
    }),
  ).toBe(true);
  expect(a.values.rows).toEqual([
    { amount: 3, note: "" },
    { amount: 2, note: "" },
  ]);
  expect(
    await store.batchUpdateEntries(form.id, selection([a]), {
      fieldId: "quantity",
      mode: "formula",
      expression: "SUM({{amount}})",
    }),
  ).toBe(false);
});
it("does not write any record when selection is stale, deleted, unsubmitted, duplicated or missing", async () => {
  const { store, form, a, b } = await setup(),
    stale = selection([a, b]);
  expect(await store.updateEntry(b.id, { ...b.values, quantity: 4 })).toBe(
    true,
  );
  const before = copy(store.data.entries);
  for (const chosen of [
    stale,
    [],
    selection([a, a]),
    [...selection([a]), { ...selection([b])[0]!, id: "missing" }],
  ]) {
    expect(
      await store.batchUpdateEntries(form.id, chosen, {
        fieldId: "serial",
        mode: "fixed",
        value: "同号",
      }),
    ).toBe(false);
    expect(store.data.entries).toEqual(before);
  }
  const pending = (await store.submitEntry(form.id, {}, "draft"))!;
  expect(
    await store.batchUpdateEntries(form.id, selection([a, pending]), {
      fieldId: "serial",
      mode: "empty",
    }),
  ).toBe(false);
  expect(await store.recycleEntries([b.id], true)).toBe(true);
  const recycled = copy(store.data.entries);
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "serial",
      mode: "empty",
    }),
  ).toBe(false);
  expect(store.data.entries).toEqual(recycled);
});
it("rejects unique columns, invalid results, unavailable references and forbidden functions without partial effects", async () => {
  const { store, form, a, b } = await setup(),
    before = copy(store.data.entries);
  for (const change of [
    { fieldId: "code", mode: "fixed", value: "重复" },
    { fieldId: "total", mode: "fixed", value: 5 },
    { fieldId: "quantity", mode: "formula", expression: "1 / 0" },
    { fieldId: "quantity", mode: "formula", expression: "{{missing}} + 1" },
    {
      fieldId: "quantity",
      mode: "formula",
      expression: "IF(ISEMPTY({{required}}), 1, 0)",
    },
    { fieldId: "quantity", mode: "fixed", value: "不是数字" },
  ] as const) {
    expect(
      await store.batchUpdateEntries(form.id, selection([a, b]), change),
    ).toBe(false);
    expect(store.data.entries).toEqual(before);
  }
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "choice",
      mode: "formula",
      expression: '"乙"',
    }),
  ).toBe(true);
  expect([a.values.choice, b.values.choice]).toEqual(["b", "b"]);
});
it("rolls back the entire batch and audit when persistence fails", async () => {
  const { store, form, a, b } = await setup(),
    before = copy(store.data.entries),
    counters = copy(store.data.serialCounters);
  failSave = true;
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "serial",
      mode: "fixed",
      value: "失败值",
    }),
  ).toBe(false);
  expect(store.data.entries).toEqual(before);
  expect(store.data.serialCounters).toEqual(counters);
  failSave = false;
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "serial",
      mode: "fixed",
      value: "重试",
    }),
  ).toBe(true);
  expect(saved().entries.find((e) => e.id === a.id)?.values.serial).toBe(
    "重试",
  );
});
it("uses pinned definitions and rejects mixed target types without rewriting versions", async () => {
  const { store, form, draft, a, b } = await setup();
  draft.schema.fields.find((f) => f.id === "quantity")!.type = "text";
  draft.schema.fields.find((f) => f.id === "quantity")!.format = "none";
  draft.schema.fields.find((f) => f.id === "total")!.expression =
    "LEN({{quantity}})";
  expect(await store.publishForm(form.id)).toBe(true);
  const c = (await store.submitEntry(form.id, {
    code: "C",
    required: "保留",
    quantity: "新版本",
  }))!;
  expect(
    await store.batchUpdateEntries(form.id, selection([a, c]), {
      fieldId: "quantity",
      mode: "fixed",
      value: 5,
    }),
  ).toBe(false);
  expect(a.values.quantity).toBe(2);
  expect(c.values.quantity).toBe("新版本");
  expect(a.values.total).toBe(4);
  expect(c.values.total).toBe(3);
  expect(
    await store.batchUpdateEntries(form.id, selection([a, b]), {
      fieldId: "quantity",
      mode: "formula",
      expression: "{{quantity}} + 1",
    }),
  ).toBe(true);
  expect([
    a.definitionVersion,
    b.definitionVersion,
    c.definitionVersion,
  ]).toEqual([1, 1, 2]);
});
it("rereads independent records under the shared lock and commits one of conflicting batches", async () => {
  const { store, form, a, b } = await setup(),
    chosen = selection([a, b]),
    other = useWorkspaceStore(createPinia());
  expect(
    await other.submitEntry(form.id, {
      code: "C",
      required: "新记录",
      quantity: 1,
    }),
  ).toBeTruthy();
  expect(
    await store.batchUpdateEntries(form.id, chosen, {
      fieldId: "serial",
      mode: "fixed",
      value: "共同编号",
    }),
  ).toBe(true);
  expect(saved().entries).toHaveLength(3);
  const latest = selection(
      store.data.entries.filter((e) => [a.id, b.id].includes(e.id)),
    ),
    left = useWorkspaceStore(createPinia()),
    right = useWorkspaceStore(createPinia());
  const outcomes = await Promise.all([
    left.batchUpdateEntries(form.id, latest, {
      fieldId: "serial",
      mode: "fixed",
      value: "左",
    }),
    right.batchUpdateEntries(form.id, latest, {
      fieldId: "serial",
      mode: "fixed",
      value: "右",
    }),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect(
    new Set(
      saved()
        .entries.filter((e) => [a.id, b.id].includes(e.id))
        .map((e) => e.values.serial),
    ).size,
  ).toBe(1);
});
