// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { copy, createField } from "../src/domain/form";
import { defaultRecordView, recordExcelExport } from "../src/domain/records";
import { useWorkspaceStore } from "../src/stores/workspace";
import { LocalWorkspaceRepository } from "../src/repositories/workspaceRepository";
import RecordList from "../src/features/forms/components/RecordList.vue";

let app: ReturnType<typeof createApp> | undefined;
beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await nextTick();
};
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

it("uses committed row height after successful or failed saves without losing columns, sort or records", async () => {
  const { store, form } = await setup();
  await store.submitEntry(form.id, { note: "第一行\n第二行\n第三行" });
  const view = {
    ...defaultRecordView(form.schema),
    sortField: "note",
    descending: false,
    pageSize: 10 as const,
  };
  await store.saveRecordView(form.id, view);
  const entries = copy(store.data.entries);
  document.body.innerHTML = '<div id="mount"></div>';
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { template: "<div/>" } }],
  });
  await router.push("/");
  app = createApp(() => h(RecordList, { form, schema: form.schema }));
  const pinia = createPinia();
  const mountedStore = useWorkspaceStore(pinia);
  app.use(pinia);
  app.use(router);
  app.mount("#mount");
  await settle();
  const selector = document.querySelector<HTMLSelectElement>(
    '[aria-label="记录行高"]',
  )!;
  let finish!: () => void;
  const save = mountedStore.saveRecordView.bind(mountedStore);
  const command = vi
    .spyOn(mountedStore, "saveRecordView")
    .mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return save(...args);
    });
  selector.value = "medium";
  selector.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(selector.closest("fieldset")!.disabled).toBe(true);
  expect(document.querySelector('[role="status"]')!.textContent).toContain(
    "正在保存",
  );
  finish();
  await vi.waitFor(() =>
    expect(selector.closest("fieldset")!.disabled).toBe(false),
  );
  expect(command).toHaveBeenCalledTimes(1);
  expect(document.querySelector("table")!.dataset.rowHeight).toBe("medium");
  expect(new LocalWorkspaceRepository().load()!.recordViews![form.id]).toEqual({
    ...view,
    rowHeight: "medium",
  });
  command.mockResolvedValueOnce(false);
  selector.value = "auto";
  selector.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(selector.value).toBe("medium");
  expect(document.querySelector("table")!.dataset.rowHeight).toBe("medium");
  expect(mountedStore.data.entries).toEqual(entries);
  expect(mountedStore.data.recordViews![form.id]).toEqual({
    ...view,
    rowHeight: "medium",
  });
});
