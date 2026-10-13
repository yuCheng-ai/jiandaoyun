// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import { recordExcelExport } from "../src/domain/records";
import { useWorkspaceStore } from "../src/stores/workspace";
import { LocalWorkspaceRepository } from "../src/repositories/workspaceRepository";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
async function setup() {
  const store = useWorkspaceStore();
  const form = (await store.createForm("oa", "多行记录", "form"))!;
  const draft = store.openForm(form.id)!;
  draft.schema.fields = [
    createField("textarea", { id: "note", label: "说明" }),
  ];
  expect(await store.publishForm(form.id)).toBe(true);
  return { store, form: store.data.forms.find((f) => f.id === form.id)! };
}

it("preserves long multiline text through draft reload, same-ID submission, historical editing and validated import/export", async () => {
  const { store, form } = await setup();
  const text = "首行\n" + "完整说明，不截断。\n".repeat(1100) + "末行";
  expect(text.length).toBeGreaterThan(10000);
  const draft = (await store.submitEntry(form.id, { note: text }, "draft"))!;
  const reloaded = useWorkspaceStore(createPinia());
  expect(
    reloaded.data.entries.find((e) => e.id === draft.id)?.values.note,
  ).toBe(text);
  const submitted = (await reloaded.submitEntry(
    form.id,
    { note: text },
    "submitted",
    draft.id,
  ))!;
  expect(submitted.id).toBe(draft.id);
  expect(submitted.status).toBe("submitted");
  const original = copy(
    reloaded.data.forms.find((f) => f.id === form.id)!.published!,
  );
  const design = reloaded.openForm(form.id)!;
  design.schema.fields[0]!.maxLength = 200;
  expect(await reloaded.publishForm(form.id)).toBe(true);
  const edited = text + "\n修改后末行";
  expect(await reloaded.updateEntry(submitted.id, { note: edited })).toBe(true);
  expect(submitted.definitionVersion).toBe(1);
  expect(
    reloaded.data.forms.find((f) => f.id === form.id)!.versions[0],
  ).toEqual(original);
  expect(await reloaded.submitEntry(form.id, { note: edited })).toBeFalsy();
  design.schema.fields[0]!.maxLength = 0;
  expect(await reloaded.publishForm(form.id)).toBe(true);
  const result = await reloaded.importEntries(form.id, {
    mode: "create",
    definitionVersion: 3,
    rows: [[edited]],
    firstRow: 2,
    validate: true,
    triggerWorkflow: false,
    mapping: [{ column: 0, fieldId: "note", type: "textarea" }],
    targets: [],
  });
  expect(result).toMatchObject({ created: 1, updated: 0 });
  const saved = new LocalWorkspaceRepository().load()!;
  const entries = saved.entries.filter((e) => e.formId === form.id);
  expect(entries).toHaveLength(2);
  expect(entries.every((e) => e.values.note === edited)).toBe(true);
  const schema = original.schema;
  const exported = recordExcelExport(
    saved,
    schema.fields,
    [],
    entries.map((entry) => ({ entry, schema, extra: [] })),
  );
  expect(exported.rows.slice(-2)).toEqual([[edited], [edited]]);
});
