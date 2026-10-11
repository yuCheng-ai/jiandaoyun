// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, shallowRef, triggerRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import FormFields from "../src/features/forms/components/FormFields.vue";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import { createField, emptySchema, copy } from "../src/domain/form";
import { newForm, type FormRecord } from "../src/domain/workspace";
import { restoreRuntimeDraft } from "../src/domain/editorDraftAdapters";

let pinia = createPinia();
const cleanups: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
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
async function mount(component: any, props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  const app = createApp({ render: () => h(component, props) });
  app.use(pinia);
  app.use(router);
  app.mount(host);
  cleanups.push(() => app.unmount());
  await flush();
  return host;
}
function fixture() {
  const schema = emptySchema();
  schema.settings.cacheDraft = false;
  const tabs = createField("tabs", {
    id: "sections",
    label: "申请分组",
    tabs: [
      { id: "empty", label: "空标签" },
      { id: "info", label: "申请信息" },
      { id: "approval", label: "审批意见" },
      { id: "hidden", label: "保密标签" },
    ],
    children: [
      createField("text", {
        id: "name",
        label: "申请人",
        required: true,
        tabId: "info",
      }),
      createField("text", {
        id: "comment",
        label: "意见",
        required: true,
        tabId: "approval",
      }),
      createField("text", {
        id: "secret",
        label: "保密内容",
        visible: false,
        tabId: "hidden",
      }),
    ],
  });
  schema.fields = [tabs];
  return { schema, tabs };
}
it("readonly tab containers protect all nested controls and row actions while tabs remain navigable", async () => {
  const { schema, tabs } = fixture();
  tabs.editable = false;
  tabs.children.push(
    createField("subform", {
      id: "rows",
      label: "商品明细",
      tabId: "info",
      children: [createField("text", { id: "sku", label: "商品" })],
    }),
  );
  const host = await mount(FormFields, {
    fields: schema.fields,
    schema,
    values: { name: "原申请人", rows: [{ sku: "原商品" }] },
  });
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="申请人"]')!.disabled,
  ).toBe(true);
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="商品明细 第1行 商品"]')!
      .disabled,
  ).toBe(true);
  expect(host.querySelector('[aria-label="删除商品明细第1行"]')).toBeNull();
  expect(
    Array.from(host.querySelectorAll("button")).some((e) =>
      e.textContent?.includes("添加商品明细"),
    ),
  ).toBe(false);
  await choose(host, "审批意见");
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="意见"]')!.disabled,
  ).toBe(true);
});
it("draft restore retains readonly and hidden container descendants while allowing unrelated fields", () => {
  for (const flags of [{ editable: false }, { visible: false }]) {
    const { schema, tabs } = fixture();
    Object.assign(tabs, flags);
    tabs.children.push(
      createField("subform", {
        id: "rows",
        children: [createField("text", { id: "sku" })],
      }),
    );
    schema.fields.push(createField("text", { id: "outside" }));
    const before = {
      name: "原申请人",
      comment: "原意见",
      secret: "原隐藏内容",
      rows: [{ sku: "原商品" }],
      outside: "原外部",
    };
    expect(
      restoreRuntimeDraft(
        {
          name: "覆盖",
          comment: "覆盖",
          secret: "覆盖",
          rows: [{ sku: "覆盖" }],
          outside: "修改",
        },
        schema.fields,
        before,
      ),
    ).toEqual({ ...before, outside: "修改" });
  }
});
it("readonly field groups disable ordinary and rich-text editing without requiring a second disabled flag", async () => {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "plain", label: "名称" }),
    createField("richtext", { id: "rich", label: "说明" }),
    createField("file", { id: "files", label: "附件" }),
  ];
  const host = await mount(FormFields, {
    fields: schema.fields,
    schema,
    readonly: true,
    values: { plain: "保留名称", rich: "<p>保留说明</p>", files: [] },
  });
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="名称"]')!.disabled,
  ).toBe(true);
  expect(
    host.querySelector('[aria-label="说明"]')!.getAttribute("contenteditable"),
  ).toBe("false");
  expect(host.querySelector(".rich-toolbar,.file-select")).toBeNull();
});
const tabButtons = (host: Element) => [
  ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
];
const selected = (host: Element) =>
  host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
async function choose(host: Element, label: string) {
  tabButtons(host)
    .find((el) => el.textContent?.trim() === label)!
    .click();
  await flush();
}
async function key(button: HTMLButtonElement, name: string) {
  button.focus();
  button.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
}
async function fill(host: Element, label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`,
  )!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}
async function submit(host: Element) {
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
}

it("omits empty and permission-hidden runtime tabs, selects the first visible content and leaves schema and values intact", async () => {
  const { schema } = fixture(),
    before = copy(schema),
    values = { name: "甲", comment: "待处理", secret: "旧值" };
  const host = await mount(FormFields, {
    schema,
    fields: schema.fields,
    values,
  });
  expect(tabButtons(host).map((el) => el.textContent?.trim())).toEqual([
    "申请信息",
    "审批意见",
  ]);
  expect(selected(host).textContent?.trim()).toBe("申请信息");
  expect(host.textContent).not.toContain("保密标签");
  expect(schema).toEqual(before);
  expect(values).toEqual({ name: "甲", comment: "待处理", secret: "旧值" });
});
it("falls back when the active tab becomes rule-hidden and hides the whole empty container without clearing retained inputs", async () => {
  const { schema } = fixture();
  schema.fields.unshift(createField("text", { id: "show", label: "是否显示" }));
  schema.settings.rules = [
    {
      id: "show",
      sourceId: "show",
      operator: "equals",
      value: "yes",
      targetIds: ["comment"],
    },
  ];
  const state = reactive({
    schema,
    values: { name: "甲", comment: "原意见", show: "yes" },
  });
  const current = await mount(
    {
      render: () =>
        h(FormFields, {
          schema: state.schema,
          fields: state.schema.fields,
          values: state.values,
        }),
    },
    {},
  );
  await choose(current, "审批意见");
  state.values.show = "no";
  await flush();
  expect(selected(current).textContent?.trim()).toBe("申请信息");
  expect(current.textContent).not.toContain("审批意见");
  expect(state.values.comment).toBe("原意见");
  state.values.show = "yes";
  await flush();
  expect(selected(current).textContent?.trim()).toBe("申请信息");
  state.values.show = "no";
  state.schema.fields[1]!.children[0]!.visible = false;
  await flush();
  expect(current.querySelector('[data-field-id="sections"]')).toBeNull();
  expect(state.values).toEqual({ name: "甲", comment: "原意见", show: "no" });
});
it("does not retain a tab that contains only a lookup suppressed in readonly record display", async () => {
  const { schema, tabs } = fixture();
  tabs.children[1] = createField("lookup", { id: "pick", tabId: "approval" });
  const host = await mount(FormFields, {
    schema,
    fields: schema.fields,
    values: { name: "甲" },
    readonly: true,
    disabled: true,
  });
  expect(tabButtons(host).map((el) => el.textContent?.trim())).toEqual([
    "申请信息",
  ]);
});
it("preserves historical unassigned children and zero-tab schemas rather than dropping their controls", async () => {
  const { schema, tabs } = fixture();
  tabs.tabs = [];
  tabs.children = [createField("text", { id: "common", label: "历史字段" })];
  const host = await mount(FormFields, {
    schema,
    fields: schema.fields,
    values: { common: "保留" },
  });
  expect(tabButtons(host)).toHaveLength(0);
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="历史字段"]')!.value,
  ).toBe("保留");
});
it("supports roving keyboard focus, wraparound, Home/End and correctly linked panels in readonly forms", async () => {
  const { schema } = fixture();
  const host = await mount(FormFields, {
    schema,
    fields: schema.fields,
    values: {},
    readonly: true,
    disabled: true,
  });
  await key(selected(host), "ArrowRight");
  expect(selected(host).textContent?.trim()).toBe("审批意见");
  expect(document.activeElement).toBe(selected(host));
  expect(tabButtons(host).map((el) => el.tabIndex)).toEqual([-1, 0]);
  const panel = host.querySelector('[role="tabpanel"]')!;
  expect(selected(host).getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-labelledby")).toBe(selected(host).id);
  await key(selected(host), "ArrowRight");
  expect(selected(host).textContent?.trim()).toBe("申请信息");
  await key(selected(host), "ArrowLeft");
  expect(selected(host).textContent?.trim()).toBe("审批意见");
  await key(selected(host), "Home");
  expect(selected(host).textContent?.trim()).toBe("申请信息");
  await key(selected(host), "End");
  expect(selected(host).textContent?.trim()).toBe("审批意见");
  const modified = new KeyboardEvent("keydown", {
    key: "ArrowLeft",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  selected(host).dispatchEvent(modified);
  await flush();
  expect(selected(host).textContent?.trim()).toBe("审批意见");
  expect(modified.defaultPrevented).toBe(false);
});
it("uses distinct tab and panel identities when the same schema appears in multiple views", async () => {
  const { schema } = fixture();
  const host = await mount(
    {
      render: () =>
        h("div", [
          h(FormFields, { schema, fields: schema.fields, values: {} }),
          h(FormFields, { schema, fields: schema.fields, values: {} }),
        ]),
    },
    {},
  );
  const ids = [...host.querySelectorAll('[role="tab"], [role="tabpanel"]')].map(
    (el) => el.id,
  );
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});
it("keeps all design tabs reachable and adds fields to the tab selected by the keyboard", async () => {
  const form = shallowRef<FormRecord>(newForm("oa", "标签验收"));
  form.value.schema = fixture().schema;
  let designer!: ReturnType<typeof useFormDesigner>;
  const host = await mount(
    {
      setup() {
        designer = useFormDesigner(form);
        return () =>
          h(FieldCanvas, {
            fields: form.value.schema.fields,
            selectedIds: designer.selectedIds.value,
            activeTabId: designer.activeTabId.value,
            onSelect: designer.select,
            onContext: designer.setContext,
          });
      },
    },
    {},
  );
  expect(tabButtons(host).map((el) => el.textContent?.trim())).toEqual([
    "空标签",
    "申请信息",
    "审批意见",
    "保密标签",
  ]);
  await key(selected(host), "ArrowRight");
  designer.add("number");
  triggerRef(form);
  await flush();
  const added = form.value.schema.fields[0]!.children.at(-1)!;
  expect(added.type).toBe("number");
  expect(added.tabId).toBe("info");
  expect(host.querySelector(`[data-field-id="${added.id}"]`)).not.toBeNull();
});
it("returns the designer to an existing tab after a schema replacement removes the selected tab", async () => {
  const { schema } = fixture(),
    state = reactive({ fields: schema.fields, activeTabId: "empty" });
  const host = await mount(
    {
      render: () =>
        h(FieldCanvas, {
          fields: state.fields,
          selectedIds: [],
          activeTabId: state.activeTabId,
          onContext: (_parent: string | null, id?: string) => {
            if (id) state.activeTabId = id;
          },
        }),
    },
    {},
  );
  await choose(host, "审批意见");
  const next = copy(schema.fields);
  next[0]!.tabs = next[0]!.tabs.filter((tab) => tab.id !== "approval");
  state.fields = next;
  await flush();
  expect(selected(host).textContent?.trim()).toBe("空标签");
});
it("reveals invalid fields only on submission, preserves the chosen tab while correcting another error and persists both values", async () => {
  const { schema } = fixture(),
    persist = vi.fn().mockResolvedValue(true);
  const host = await mount(FormRuntime, {
    schema,
    formId: "tab-validation",
    preview: false,
    initialValues: { name: "", comment: "" },
    persistValues: persist,
  });
  const scroll = vi.fn();
  tabButtons(host).find(
    (element) => element.textContent?.trim() === "申请信息",
  )!.scrollIntoView = scroll;
  await choose(host, "审批意见");
  await submit(host);
  expect(persist).not.toHaveBeenCalled();
  expect(selected(host).textContent?.trim()).toBe("申请信息");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("申请人");
  expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  await choose(host, "审批意见");
  await fill(host, "意见", "已核实");
  expect(selected(host).textContent?.trim()).toBe("审批意见");
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="意见"]')!.value,
  ).toBe("已核实");
  await submit(host);
  expect(selected(host).textContent?.trim()).toBe("申请信息");
  await fill(host, "申请人", "合成甲");
  await submit(host);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledWith(
    { name: "合成甲", comment: "已核实" },
    false,
  );
});
it("focuses the rich-text body instead of its formatting toolbar after required validation fails", async () => {
  const schema = emptySchema();
  schema.settings.cacheDraft = false;
  schema.fields = [
    createField("richtext", {
      id: "details",
      label: "图片说明",
      required: true,
    }),
  ];
  const host = await mount(FormRuntime, {
    schema,
    formId: "required-rich-focus",
  });
  const submit = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "提交",
  )!;
  submit.click();
  await flush();
  expect(host.textContent).toContain("请填写图片说明");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("图片说明");
  expect(document.activeElement?.getAttribute("contenteditable")).toBe("true");
});

it("focuses the failing subform cell, preserving the original row index after an empty row", async () => {
  const schema = emptySchema();
  schema.settings.cacheDraft = false;
  schema.fields = [
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("text", { id: "code", label: "编号", required: true }),
        createField("number", { id: "qty", label: "数量" }),
      ],
    }),
  ];
  const host = await mount(FormRuntime, {
    schema,
    formId: "required-row-focus",
    initialValues: { lines: [{}, { qty: 0 }] },
  });
  await submit(host);
  expect(host.textContent).toContain("请填写编号");
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "明细 第2行 编号",
  );
});

it("keeps focus and tab selection stable during live error refresh, then reveals the same remaining error on a repeated submission", async () => {
  const { schema } = fixture(),
    persist = vi.fn().mockResolvedValue(true);
  const host = await mount(FormRuntime, {
    schema,
    formId: "tab-live",
    preview: false,
    persistValues: persist,
  });
  await submit(host);
  await choose(host, "审批意见");
  const input = host.querySelector<HTMLInputElement>('[aria-label="意见"]')!;
  input.focus();
  await fill(host, "意见", "a");
  expect(document.activeElement).toBe(input);
  expect(selected(host).textContent?.trim()).toBe("审批意见");
  await submit(host);
  expect(selected(host).textContent?.trim()).toBe("申请信息");
  expect(persist).not.toHaveBeenCalled();
});
it("reveals an invalid nested historical tab after its outer tab is mounted on submission", async () => {
  const { schema, tabs } = fixture();
  const nested = createField("tabs", {
    id: "nested",
    tabId: "approval",
    children: [
      createField("text", { id: "ok", label: "已填项", tabId: "inner-a" }),
      createField("text", {
        id: "missing",
        label: "补充项",
        required: true,
        tabId: "inner-b",
      }),
    ],
    tabs: [
      { id: "inner-a", label: "常规" },
      { id: "inner-b", label: "补充" },
    ],
  });
  tabs.children[1] = nested;
  const persist = vi.fn().mockResolvedValue(true);
  const host = await mount(FormRuntime, {
    schema,
    formId: "nested-tabs",
    preview: false,
    initialValues: { name: "甲", ok: "保留", missing: "" },
    persistValues: persist,
  });
  await submit(host);
  expect(
    [...host.querySelectorAll('[role="tab"][aria-selected="true"]')].map((el) =>
      el.textContent?.trim(),
    ),
  ).toEqual(["审批意见", "补充"]);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("补充项");
  await fill(host, "补充项", "合成内容");
  await submit(host);
  expect(persist).toHaveBeenCalledWith(
    { name: "甲", ok: "保留", missing: "合成内容" },
    false,
  );
});
it("scopes explicit error navigation to the current path instead of switching another row's tabs", async () => {
  const { schema } = fixture();
  const state = reactive({
    errors: [
      { fieldId: "comment", path: "rows.0.comment", message: "请填写意见" },
    ],
    attempt: 1,
  });
  const host = await mount(
    {
      render: () =>
        h(FormFields, {
          schema,
          fields: schema.fields,
          values: {},
          prefix: "rows.1.",
          errors: state.errors,
          validationAttempt: state.attempt,
        }),
    },
    {},
  );
  expect(selected(host).textContent?.trim()).toBe("申请信息");
  state.errors = [
    { fieldId: "comment", path: "rows.1.comment", message: "请填写意见" },
  ];
  state.attempt++;
  await flush();
  expect(selected(host).textContent?.trim()).toBe("审批意见");
});
