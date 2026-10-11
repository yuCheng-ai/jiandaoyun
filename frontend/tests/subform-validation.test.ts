// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  validateValues,
  type FormValues,
} from "../src/domain/form";
import { seedWorkspace } from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import { WORKSPACE_KEY } from "../src/repositories/workspaceRepository";

function fixture() {
  const schema = emptySchema();
  const code = createField("text", {
    id: "code",
    label: "明细编号",
    required: true,
    unique: true,
  });
  const quantity = createField("number", { id: "quantity", label: "数量" });
  const rows = createField("subform", {
    id: "lines",
    label: "明细",
    children: [code, quantity],
  });
  schema.fields = [rows];
  return { schema, code, quantity, rows };
}

let memory: Map<string, string>;
beforeEach(() => {
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("skips required child checks for wholly blank optional rows, ignoring metadata and decorations", () => {
  const { schema, rows } = fixture();
  rows.children.push(
    createField("divider", { id: "section" }),
    createField("button", { id: "action" }),
    createField("richtext", { id: "note" }),
    createField("address", { id: "address" }),
    createField("file", { id: "files" }),
  );
  const values = {
    lines: [
      {},
      {
        _rowId: "kept",
        removedField: "legacy",
        section: "title",
        action: "clicked",
      },
      {
        code: "  ",
        note: "<p><br>&nbsp;</p>",
        address: { province: "" },
        files: [],
      },
    ],
  };
  const before = copy(values);
  expect(validateValues(schema, values)).toEqual([]);
  expect(values).toEqual(before);
});

it("requires at least one populated row; zero activates child required checks at the original index", () => {
  const { schema, rows } = fixture();
  rows.required = true;
  expect(validateValues(schema, { lines: [{}, { code: "" }] })).toEqual([
    { fieldId: "lines", path: "lines", message: "请填写明细" },
  ]);
  expect(validateValues(schema, { lines: [{}, { quantity: 0 }] })).toEqual([
    { fieldId: "code", path: "lines.1.code", message: "请填写明细编号" },
  ]);
  expect(
    validateValues(schema, { lines: [{}, { code: "A", quantity: 0 }] }),
  ).toEqual([]);
});

it("retains hidden stored values as row content but applies child visibility rules independently", () => {
  const { schema, quantity, code } = fixture();
  quantity.visible = false;
  expect(validateValues(schema, { lines: [{ quantity: 0 }] })[0]?.path).toBe(
    "lines.0.code",
  );
  code.visible = false;
  expect(validateValues(schema, { lines: [{ quantity: 0 }] })).toEqual([]);
  code.visible = true;
  schema.settings.rules = [
    {
      id: "show",
      sourceId: "quantity",
      operator: "equals",
      value: "1",
      targetIds: ["code"],
    },
  ];
  expect(
    validateValues(schema, { lines: [{ quantity: 0 }, { quantity: 1 }] }).map(
      (error) => error.path,
    ),
  ).toEqual(["lines.1.code"]);
});

it("compares unique child values with every peer record row without confusing main fields or another subform", () => {
  const { schema } = fixture();
  const existing: FormValues[] = [
    { lines: [{ code: "A" }, { code: "B" }] },
    { lines: [{ code: "C" }] },
    { code: "D", otherLines: [{ code: "D" }] },
  ];
  expect(
    validateValues(schema, { lines: [{}, { code: "C" }] }, existing),
  ).toEqual([
    { fieldId: "code", path: "lines.1.code", message: "明细编号不能重复" },
  ]);
  expect(validateValues(schema, { lines: [{ code: "D" }] }, existing)).toEqual(
    [],
  );
});

it("a child global-unique setting also rejects repeated rows in one record while optional blanks remain exempt", () => {
  const { schema, code } = fixture();
  expect(
    validateValues(schema, { lines: [{ code: "A" }, {}, { code: "A" }] }).map(
      (error) => error.path,
    ),
  ).toEqual(["lines.0.code", "lines.2.code"]);
  code.unique = false;
  expect(
    validateValues(schema, { lines: [{ code: "A" }, { code: "A" }] }),
  ).toEqual([]);
});

it("tab containers retain main scope and nested row paths without mutating schemas or historical values", () => {
  const { schema, rows } = fixture();
  const title = createField("text", { id: "title", unique: true });
  const tabs = createField("tabs", { id: "tabs", children: [title, rows] });
  title.tabId = rows.tabId = tabs.tabs[0]!.id;
  schema.fields = [tabs];
  const restored = parseSchema(copy(schema));
  const existing = [{ title: "old", lines: [{ code: "A" }] }];
  const before = copy({ restored, existing });
  expect(
    validateValues(
      restored,
      { title: "old", lines: [{ code: "A" }] },
      existing,
    ).map((error) => error.path),
  ).toEqual(["title", "lines.0.code"]);
  expect({ restored, existing }).toEqual(before);
});

it("malformed subforms and non-object rows fail validation instead of throwing or being counted as blank", () => {
  const { schema } = fixture();
  expect(validateValues(schema, { lines: "broken" })).toEqual([
    { fieldId: "lines", path: "lines", message: "明细的明细格式无效" },
  ]);
  expect(
    validateValues(schema, { lines: [null, "bad", []] }).map(
      (error) => error.path,
    ),
  ).toEqual(["lines.0", "lines.1", "lines.2"]);
});

it("published record create and edit enforce child uniqueness, exclude self and keep failed writes and old versions intact", async () => {
  const store = useWorkspaceStore(createPinia());
  const form = (await store.createForm("oa", "合成子表校验", "form"))!;
  const draft = store.openForm(form.id)!;
  draft.schema = fixture().schema;
  expect(await store.publishForm(form.id)).toBe(true);
  const first = await store.submitEntry(form.id, { lines: [{ code: "A" }] });
  expect(first).toBeTruthy();
  const saved = memory.get(WORKSPACE_KEY);
  expect(
    await store.submitEntry(form.id, { lines: [{ code: "A" }] }),
  ).toBeUndefined();
  expect(memory.get(WORKSPACE_KEY)).toBe(saved);
  const second = await store.submitEntry(form.id, { lines: [{ code: "B" }] });
  expect(second).toBeTruthy();
  expect(
    await store.updateEntry(first!.id, { lines: [{ code: "A", quantity: 0 }] }),
  ).toBe(true);
  const before = copy(store.data.entries);
  expect(await store.updateEntry(second!.id, { lines: [{ code: "A" }] })).toBe(
    false,
  );
  expect(store.data.entries).toEqual(before);
  store.openForm(form.id)!.schema.fields[0]!.children[0]!.unique = false;
  expect(await store.publishForm(form.id)).toBe(true);
  expect(await store.updateEntry(second!.id, { lines: [{ code: "A" }] })).toBe(
    false,
  );
  expect(
    store.data.entries.filter((entry) => entry.formId === form.id),
  ).toHaveLength(2);
  expect(
    store.data.entries
      .filter((entry) => entry.formId === form.id)
      .map((entry) => entry.definitionVersion),
  ).toEqual([1, 1]);
});

it("incomplete drafts stay editable and pinned to their original child rules; rejected submission keeps identity and retry creates no extra record", async () => {
  const store = useWorkspaceStore(createPinia());
  const form = (await store.createForm("oa", "合成子表草稿", "form"))!;
  store.openForm(form.id)!.schema = fixture().schema;
  expect(await store.publishForm(form.id)).toBe(true);
  const savedDraft = (await store.submitEntry(
    form.id,
    { lines: [{}] },
    "draft",
  ))!;
  expect(savedDraft.status).toBe("draft");
  const existing = (await store.submitEntry(form.id, {
    lines: [{ code: "A" }],
  }))!;
  expect(existing).toBeTruthy();
  const otherVersion = store.openForm(form.id)!;
  otherVersion.schema.fields[0]!.children[0]!.unique = false;
  expect(await store.publishForm(form.id)).toBe(true);
  expect(
    await store.submitEntry(
      form.id,
      { lines: [{ code: "A" }] },
      "submitted",
      savedDraft.id,
    ),
  ).toBeUndefined();
  expect(
    store.data.entries.find((entry) => entry.id === savedDraft.id),
  ).toMatchObject({
    status: "draft",
    definitionVersion: 1,
    values: { lines: [{}] },
  });
  const submitted = (await store.submitEntry(
    form.id,
    { lines: [{ code: "B" }, {}] },
    "submitted",
    savedDraft.id,
  ))!;
  expect(submitted).toMatchObject({
    id: savedDraft.id,
    status: "submitted",
    definitionVersion: 1,
  });
  expect(
    store.data.entries.filter((entry) => entry.formId === form.id),
  ).toHaveLength(2);
});
