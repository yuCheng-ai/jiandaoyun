// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import { copy, createField, type FormValues } from "../src/domain/form";
import { newForm, type FormRecord } from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import { useEditorDraftStore } from "../src/stores/editorDrafts";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
import { restoreRuntimeDraft } from "../src/domain/editorDraftAdapters";
const cleanups: (() => void)[] = [];
let pinia = createPinia();
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
function publish(form: FormRecord) {
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-11",
  };
  form.versions = [copy(form.published)];
}
function fixture() {
  const store = useWorkspaceStore(),
    source = newForm("oa", "source"),
    target = newForm("oa", "target");
  source.id = "source";
  target.id = "target";
  source.schema.fields = [
    createField("text", { id: "code" }),
    createField("subform", {
      id: "remote",
      children: [
        createField("text", { id: "remoteItem" }),
        createField("number", { id: "remoteQty" }),
      ],
    }),
  ];
  target.schema.settings.cacheDraft = true;
  target.schema.fields = [
    createField("select", {
      id: "selected",
      label: "来源",
      defaultValue: "A",
      options: [
        { id: "A", label: "A" },
        { id: "B", label: "B" },
        { id: "Z", label: "Z" },
      ],
    }),
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("text", { id: "item", label: "商品" }),
        createField("number", { id: "qty", label: "数量", defaultValue: 7 }),
      ],
      subformPermissions: {
        add: true,
        insert: true,
        editExisting: false,
        deleteExisting: false,
      },
      defaultLink: {
        enabled: true,
        formId: "source",
        fieldId: "remote",
        match: "all",
        filters: [
          {
            id: "filter",
            sourceFieldId: "code",
            operator: "equals",
            source: "field",
            value: "selected",
          },
        ],
        mappings: [
          { sourceFieldId: "remoteItem", targetFieldId: "item" },
          { sourceFieldId: "remoteQty", targetFieldId: "qty" },
        ],
      },
    }),
  ];
  publish(source);
  publish(target);
  store.data.forms.push(source, target);
  for (const [code, rows] of [
    [
      "A",
      [
        { remoteItem: "A-ONE", remoteQty: 11 },
        { remoteItem: "A-TWO", remoteQty: 22 },
      ],
    ],
    ["B", [{ remoteItem: "B-ONE", remoteQty: 33 }]],
  ] as const)
    store.data.entries.push({
      id: `source-${code}`,
      formId: source.id,
      definitionVersion: 1,
      status: "submitted",
      createdAt: "2026-10-11",
      values: { code, remote: copy(rows) },
      history: [],
    });
  return { store, target };
}
async function mount(target: FormRecord) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const host = document.createElement("div");
  document.body.append(host);
  const changed = vi.fn(),
    persist = vi.fn().mockResolvedValue(true);
  const app = createApp({
    render: () =>
      h(FormRuntime, {
        schema: target.published!.schema,
        formId: target.id,
        preview: false,
        onChange: changed,
        persistValues: persist,
      }),
  });
  app.use(pinia).use(router).mount(host);
  const close = () => {
    app.unmount();
    host.remove();
  };
  cleanups.push(close);
  await flush();
  const input = (label: string) =>
    host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const select = async (code: string) => {
    host.querySelector<HTMLButtonElement>('[aria-label="来源"]')!.click();
    await flush();
    const option = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ].find((el) => el.textContent?.trim() === code)!;
    option.click();
    await flush();
  };
  const values = () => copy(changed.mock.calls.at(-1)?.[0] || {});
  const add = async () => {
    host.querySelector<HTMLButtonElement>(".subform-add")!.click();
    await flush();
  };
  const enter = async (label: string, value: string) => {
    const el = input(label);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  const submit = async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  };
  return {
    host,
    input,
    select,
    add,
    enter,
    values,
    submit,
    persist,
    close: () => {
      cleanups.splice(cleanups.indexOf(close), 1);
      close();
    },
  };
}
async function cachedB(target: FormRecord) {
  const first = await mount(target);
  await first.select("B");
  expect(first.input("明细 第1行 商品").value).toBe("B-ONE");
  await first.add();
  await first.enter("明细 第2行 商品", "MANUAL");
  if (!first.input("明细 第2行 数量").disabled)
    await first.enter("明细 第2行 数量", "0");
  const values = first.values(),
    drafts = useEditorDraftStore(),
    saved = copy(drafts.entries[0]!);
  expect(values.selected).toBe("B");
  expect(drafts.checkpoint(saved.id)).toBe(true);
  first.close();
  return { values, drafts, saved };
}
it("changes linked roots and restores manual rows without classifying them as generated rows", async () => {
  const { target, store } = fixture(),
    { values, drafts, saved } = await cachedB(target),
    next = await mount(target);
  expect(next.input("明细 第1行 商品").value).toBe("A-ONE");
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(next.input("明细 第1行 商品").value).toBe("B-ONE");
  expect(next.input("明细 第1行 商品").disabled).toBe(true);
  expect(next.input("明细 第2行 商品").value).toBe("MANUAL");
  expect(next.input("明细 第2行 商品").disabled).toBe(false);
  expect(next.values()).toEqual(values);
  expect(await store.submitEntry(target.id, next.values())).toBeTruthy();
});
it("refreshes protected generated values from the restored root's current source while retaining manual rows", async () => {
  const { target, store } = fixture(),
    { drafts, saved } = await cachedB(target);
  (
    store.data.entries.find((e) => e.id === "source-B")!.values
      .remote as FormValues[]
  )[0]!.remoteQty = 44;
  const next = await mount(target);
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(next.input("明细 第1行 数量").value).toBe("44");
  expect(next.input("明细 第2行 数量").value).toBe("0");
  expect(await store.submitEntry(target.id, next.values())).toBeTruthy();
});
it("recomputes a readonly formula prerequisite before recovering its linked protected rows", async () => {
  const { target, store } = fixture();
  target.schema.fields.splice(
    1,
    0,
    createField("text", {
      id: "linkedCode",
      label: "联动编号",
      editable: false,
      defaultFormula: true,
      expression: "CONCATENATE({{selected}})",
    }),
  );
  target.schema.fields[2]!.defaultLink!.filters[0]!.value = "linkedCode";
  publish(target);
  const { drafts, saved } = await cachedB(target);
  (
    store.data.entries.find((e) => e.id === "source-B")!.values
      .remote as FormValues[]
  )[0]!.remoteQty = 44;
  const next = await mount(target);
  expect(next.input("联动编号").value).toBe("A");
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(next.input("联动编号").value).toBe("B");
  expect(next.input("明细 第1行 商品").value).toBe("B-ONE");
  expect(next.input("明细 第1行 数量").value).toBe("44");
  expect(next.input("明细 第2行 商品").value).toBe("MANUAL");
  expect(await store.submitEntry(target.id, next.values())).toBeTruthy();
});
it("recomputes chained calculation prerequisites without accepting cached readonly results", async () => {
  const { target, store } = fixture();
  target.schema.fields.splice(
    1,
    0,
    createField("calculated", {
      id: "linkedNumber",
      label: "来源序号",
      expression: 'IF({{selected}}=="B",2,1)',
    }),
    createField("text", {
      id: "linkedCode",
      label: "联动编号",
      editable: false,
      defaultFormula: true,
      expression: 'IF({{linkedNumber}}==2,"B","A")',
    }),
  );
  target.schema.fields[3]!.defaultLink!.filters[0]!.value = "linkedCode";
  publish(target);
  const { drafts, saved } = await cachedB(target);
  const poisoned = copy(saved);
  poisoned.id = "readonly-formula-copy";
  (poisoned.value as any).values.linkedCode = "A";
  (poisoned.value as any).values.linkedNumber = 999;
  expect(drafts.capture(poisoned)).toBe(true);
  const next = await mount(target);
  expect(drafts.restore(drafts.prepareRestore(poisoned.id)!)).toBe(true);
  await flush();
  expect(next.values()).toMatchObject({
    selected: "B",
    linkedNumber: 2,
    linkedCode: "B",
  });
  expect(next.input("明细 第1行 商品").value).toBe("B-ONE");
  expect(next.input("明细 第2行 商品").value).toBe("MANUAL");
  expect(await store.submitEntry(target.id, next.values())).toBeTruthy();
});
it("retains an explicit editable formula override and recomputes its readonly dependent before restoring rows", async () => {
  const { target, store } = fixture();
  target.schema.fields.splice(
    1,
    0,
    createField("text", {
      id: "linkedCode",
      label: "联动编号",
      editable: false,
      defaultFormula: true,
      expression: "CONCATENATE({{userCode}})",
    }),
    createField("text", {
      id: "userCode",
      label: "可改编号",
      defaultFormula: true,
      expression: "CONCATENATE({{selected}})",
    }),
  );
  target.schema.fields[3]!.defaultLink!.filters[0]!.value = "linkedCode";
  const custom = copy(store.data.entries.find((e) => e.id === "source-B")!);
  custom.id = "source-custom";
  custom.values.code = "CUSTOM";
  (custom.values.remote as FormValues[])[0]!.remoteItem = "CUSTOM-ONE";
  store.data.entries.push(custom);
  publish(target);
  const first = await mount(target);
  await first.select("B");
  await first.enter("可改编号", "CUSTOM");
  expect(first.input("明细 第1行 商品").value).toBe("CUSTOM-ONE");
  await first.add();
  await first.enter("明细 第2行 商品", "MANUAL");
  const drafts = useEditorDraftStore(),
    saved = copy(drafts.entries[0]!);
  expect(drafts.checkpoint(saved.id)).toBe(true);
  first.close();
  const next = await mount(target);
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(next.input("可改编号").value).toBe("CUSTOM");
  expect(next.input("联动编号").value).toBe("CUSTOM");
  expect(next.input("明细 第1行 商品").value).toBe("CUSTOM-ONE");
  expect(next.input("明细 第2行 商品").value).toBe("MANUAL");
  expect(await store.submitEntry(target.id, next.values())).toBeTruthy();
});
it("keeps both current values and protection baseline unchanged after a rejected oversized recovery", async () => {
  const { target } = fixture(),
    { drafts, saved } = await cachedB(target),
    next = await mount(target);
  const oversized = copy(saved);
  (oversized.value as any).values.lines.push(
    ...Array.from({ length: 200 }, (_, i) => ({
      _rowId: `overflow-${i}`,
      item: "OVER",
      qty: 0,
    })),
  );
  oversized.id = "oversized";
  expect(drafts.capture(oversized)).toBe(true);
  expect(drafts.restore(drafts.prepareRestore(oversized.id)!)).toBe(false);
  await flush();
  expect(next.input("明细 第1行 商品").value).toBe("A-ONE");
  await next.submit();
  expect(next.persist).toHaveBeenCalledOnce();
  expect(drafts.entries.some((d) => d.id === oversized.id)).toBe(true);
});
it("protects readonly columns using the restored source rather than the initial root's row values", async () => {
  const { target, store } = fixture();
  target.schema.fields[1]!.children[1]!.editable = false;
  publish(target);
  const { drafts, saved } = await cachedB(target),
    next = await mount(target);
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(next.input("明细 第1行 数量").value).toBe("33");
  expect(next.input("明细 第2行 数量").value).toBe("7");
  expect(await store.submitEntry(target.id, next.values())).toBeTruthy();
});
it("keeps the manual row's identity when current source rows grow or disappear", async () => {
  const { target, store } = fixture(),
    { drafts, saved, values } = await cachedB(target);
  const source = store.data.entries.find((entry) => entry.id === "source-B")!;
  (source.values.remote as FormValues[]).push({
    remoteItem: "B-TWO",
    remoteQty: 55,
  });
  const expanded = await mount(target);
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(expanded.input("明细 第2行 商品").value).toBe("B-TWO");
  expect(expanded.input("明细 第2行 商品").disabled).toBe(true);
  expect((expanded.values().lines as FormValues[])[2]).toEqual(
    (values.lines as FormValues[])[1],
  );
  expect(await store.submitEntry(target.id, expanded.values())).toBeTruthy();
  expanded.close();
  source.deletedAt = "2026-10-11";
  const removed = await mount(target);
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(removed.input("明细 第1行 商品").value).toBe("MANUAL");
  expect(removed.input("明细 第1行 商品").disabled).toBe(false);
  expect(removed.values().lines).toEqual([(values.lines as FormValues[])[1]]);
  expect(await store.submitEntry(target.id, removed.values())).toBeTruthy();
});
it("retains a cached manual insertion before a protected generated row", async () => {
  const { target, store } = fixture(),
    { drafts, saved, values } = await cachedB(target);
  (saved.value as { values: FormValues }).values.lines = [
    ...(values.lines as FormValues[]),
  ].reverse();
  expect(drafts.capture(saved)).toBe(true);
  const next = await mount(target);
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(next.input("明细 第1行 商品").value).toBe("MANUAL");
  expect(next.input("明细 第1行 商品").disabled).toBe(false);
  expect(next.input("明细 第2行 商品").disabled).toBe(true);
  expect(await store.submitEntry(target.id, next.values())).toBeTruthy();
});
it("restores permitted edits to generated rows while rebasing their readonly columns", async () => {
  const { target, store } = fixture();
  target.schema.fields[1]!.subformPermissions!.editExisting = true;
  target.schema.fields[1]!.children[1]!.editable = false;
  publish(target);
  const { drafts, saved } = await cachedB(target);
  (
    (saved.value as { values: FormValues }).values.lines as FormValues[]
  )[0]!.item = "EDITED";
  expect(drafts.capture(saved)).toBe(true);
  (
    store.data.entries.find((entry) => entry.id === "source-B")!.values
      .remote as FormValues[]
  )[0]!.remoteQty = 44;
  const next = await mount(target);
  expect(drafts.restore(drafts.prepareRestore(saved.id)!)).toBe(true);
  await flush();
  expect(next.input("明细 第1行 商品").value).toBe("EDITED");
  expect(next.input("明细 第1行 数量").value).toBe("44");
  expect(await store.submitEntry(target.id, next.values())).toBeTruthy();
});
it("clamps cached column edits to the applicable existing, insertion and append grants", () => {
  const field = createField("subform", {
    id: "lines",
    children: [
      createField("text", { id: "item" }),
      createField("number", {
        id: "qty",
        defaultValue: 7,
        rowEditAccess: { existing: false, insert: false, append: true },
      }),
    ],
  });
  const current = { lines: [{ _rowId: "old", item: "OLD", qty: 11 }] };
  const next = restoreRuntimeDraft(
    {
      lines: [
        { _rowId: "insert", item: "INSERT", qty: 99 },
        { _rowId: "old", item: "EDITED", qty: 99 },
        { _rowId: "append", item: "APPEND", qty: 0 },
      ],
    },
    [field],
    current,
    current,
  );
  expect((next.lines as FormValues[]).map((row) => row.qty)).toEqual([
    7, 11, 0,
  ]);
  expect((next.lines as FormValues[]).map((row) => row.item)).toEqual([
    "INSERT",
    "EDITED",
    "APPEND",
  ]);
  expect(current.lines[0]!.qty).toBe(11);
});
