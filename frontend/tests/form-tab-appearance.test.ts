// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  reactive,
  shallowRef,
  triggerRef,
} from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  composeFormSchema,
  separateFormSchema,
  formTabStyles,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  copy,
  defaultValues,
  resolveFormValues,
} from "../src/domain/form";
import TabFieldInspector from "../src/features/forms/components/TabFieldInspector.vue";
import OptionColorPicker from "../src/components/OptionColorPicker.vue";
import FormTabBar from "../src/features/forms/components/FormTabBar.vue";
import FormFields from "../src/features/forms/components/FormFields.vue";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import ExternalFormFrame from "../src/features/forms/components/ExternalFormFrame.vue";
import { customStyleFromTheme } from "../src/domain/externalStyle";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import { newForm, type FormRecord } from "../src/domain/workspace";
import BaseDialog from "../src/components/BaseDialog.vue";
import TabStylePicker from "../src/features/forms/components/TabStylePicker.vue";

const cleanup: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(render: () => any) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render });
  app.use(createPinia());
  app.mount(host);
  cleanup.push(() => app.unmount());
  await flush();
  return host;
}
function fixture() {
  const schema = emptySchema();
  const tabs = createField("tabs", {
    id: "sections",
    tabs: [
      { id: "info", label: "申请信息" },
      { id: "approval", label: "审批意见" },
    ],
  });
  const amount = createField("number", {
    id: "amount",
    label: "金额",
    defaultValue: 3,
    tabId: "info",
  });
  const total = createField("calculated", {
    id: "total",
    label: "合计",
    expression: "{amount}*2",
    tabId: "info",
  });
  const comment = createField("textarea", {
    id: "comment",
    label: "意见",
    tabId: "approval",
  });
  tabs.children = [amount, total, comment];
  schema.fields = [tabs];
  return { schema, tabs };
}
it.each(["resize", "scroll"])(
  "dismisses a moved style menu on %s while keeping the parent editing dialog and field intact",
  async (movement) => {
    // jsdom lacks inert reflection and layout; retain real DOM focus and events.
    const inert = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "inert",
    );
    Object.defineProperty(HTMLElement.prototype, "inert", {
      configurable: true,
      get() {
        return this.hasAttribute("inert");
      },
      set(value) {
        this.toggleAttribute("inert", !!value);
      },
    });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      function (this: HTMLElement) {
        return (this.isConnected && !this.hidden
          ? [{}]
          : []) as unknown as DOMRectList;
      },
    );
    const { tabs } = fixture();
    const original = copy(tabs),
      closeParent = vi.fn(),
      select = vi.fn();
    await mount(() =>
      h(
        BaseDialog,
        {
          open: true,
          title: "编辑字段",
          onClose: closeParent,
        },
        {
          default: () =>
            h("div", { class: "anchor-scroller" }, [
              h(TabStylePicker, { field: tabs, onSelect: select }),
            ]),
        },
      ),
    );
    cleanup.push(() => {
      if (inert) Object.defineProperty(HTMLElement.prototype, "inert", inert);
      else delete (HTMLElement.prototype as any).inert;
    });
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="标签页样式"][aria-haspopup]',
    )!;
    trigger.focus();
    trigger.click();
    await flush();
    const menu = document.querySelector<HTMLElement>(".tab-style-menu")!;
    expect(menu).not.toBeNull();
    menu.dispatchEvent(new Event("scroll"));
    await flush();
    expect(document.querySelector(".tab-style-menu")).toBe(menu);
    const unrelated = document.createElement("div");
    document.body.append(unrelated);
    unrelated.dispatchEvent(new Event("scroll"));
    await flush();
    expect(document.querySelector(".tab-style-menu")).toBe(menu);
    if (movement === "resize") window.dispatchEvent(new Event("resize"));
    else
      trigger.closest(".anchor-scroller")!.dispatchEvent(new Event("scroll"));
    await flush();
    expect(document.querySelector(".tab-style-menu")).toBeNull();
    expect(
      document.querySelector('dialog[aria-label="编辑字段"]'),
    ).not.toBeNull();
    expect(closeParent).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(tabs).toEqual(original);
    expect(document.activeElement).toBe(trigger);
  },
);
it("keeps all five appearances in JSON and compatibility projection without changing values or model identity", () => {
  const { schema, tabs } = fixture(),
    originalValues = resolveFormValues(schema, defaultValues(schema.fields));
  const originalModel = separateFormSchema(schema).model;
  for (const style of formTabStyles) {
    tabs.tabStyle = style;
    tabs.tabCustomColor = true;
    tabs.tabColor = "#5865f5";
    expect(parseSchema(copy(schema))).toEqual(schema);
    const split = separateFormSchema(schema);
    expect(split.model).toEqual(originalModel);
    expect(composeFormSchema(split.model, split.page)).toEqual(schema);
    expect(resolveFormValues(schema, copy(originalValues))).toEqual(
      originalValues,
    );
  }
});
it("uses cards for new containers while missing historical appearance stays missing and renders the original underline", async () => {
  const { schema, tabs } = fixture();
  expect(tabs.tabStyle).toBe("card");
  delete tabs.tabStyle;
  const historical = copy(schema);
  expect(parseSchema(historical)).toEqual(historical);
  const host = await mount(() =>
    h(FormTabBar, {
      items: tabs.tabs,
      label: tabs.label,
      variant: "runtime",
      appearance: tabs,
    }),
  );
  expect(
    host
      .querySelector('[role="tablist"]')
      ?.classList.contains("tab-style-line"),
  ).toBe(true);
  expect(historical).toEqual(schema);
});
it("rejects invalid styles, nonboolean toggles, unsafe CSS and appearance on an ordinary field", () => {
  const { schema, tabs } = fixture();
  for (const patch of [
    { tabStyle: "other" },
    { tabCustomColor: "yes" },
    { tabColor: "red;position:fixed" },
    { tabColor: "url(https://invalid)" },
    { tabColor: "#fff" },
  ])
    expect(() =>
      parseSchema({ ...schema, fields: [{ ...tabs, ...patch }] }),
    ).toThrow(/标签页/);
  expect(() =>
    parseSchema({
      ...schema,
      fields: [createField("text", { tabColor: "#123456" })],
    }),
  ).toThrow(/标签页/);
});
it("selects appearance through the inspector as an undoable field change, preserving selection, children and published snapshots", async () => {
  const { schema, tabs } = fixture();
  let editor!: ReturnType<typeof useFormDesigner>;
  const record = shallowRef<FormRecord>({
    ...newForm("oa", "多标签验收"),
    schema,
  });
  const original = copy(schema),
    published = copy(schema),
    values = defaultValues(schema.fields);
  const root = defineComponent({
    setup() {
      editor = useFormDesigner(record);
      editor.select(tabs.id);
      editor.activeParent.value = tabs.id;
      editor.activeTabId.value = "approval";
      return () =>
        h(TabFieldInspector, {
          field: record.value.schema.fields[0],
          schema: record.value.schema,
          applySchema: (next: typeof schema) =>
            editor.transact(() => {
              record.value.schema = next;
              triggerRef(record);
            }),
          onUpdate: (patch: object) =>
            editor.transact(() => {
              Object.assign(record.value.schema.fields[0]!, patch);
              triggerRef(record);
            }),
        });
    },
  });
  const host = await mount(() => h(root));
  const trigger = host.querySelector<HTMLButtonElement>(
    '[aria-label="标签页样式"]',
  )!;
  trigger.focus();
  trigger.click();
  await flush();
  expect(document.querySelectorAll('[role="option"]').length).toBe(5);
  document
    .querySelector<HTMLButtonElement>(
      '[role="option"][aria-label="标签页样式 5"]',
    )!
    .click();
  await flush();
  expect(record.value.schema.fields[0]!.tabStyle).toBe("slant");
  expect(document.activeElement).toBe(trigger);
  expect(record.value.schema.fields[0]!.children).toEqual(
    original.fields[0]!.children,
  );
  expect(editor.activeTabId.value).toBe("approval");
  editor.undo();
  triggerRef(record);
  expect(record.value.schema).toEqual(original);
  editor.redo();
  triggerRef(record);
  expect(record.value.schema.fields[0]!.tabStyle).toBe("slant");
  await flush();
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  toggle.click();
  await flush();
  host.querySelector<HTMLButtonElement>('[aria-label="标签页颜色"]')!.click();
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="颜色 #2f7deb"]')!
    .click();
  await flush();
  expect(record.value.schema.fields[0]!.tabColor).toBe("#2f7deb");
  toggle.click();
  await flush();
  expect(record.value.schema.fields[0]!.tabCustomColor).toBe(false);
  expect(record.value.schema.fields[0]!.tabColor).toBe("#2f7deb");
  toggle.click();
  await flush();
  expect(record.value.schema.fields[0]!.tabColor).toBe("#2f7deb");
  expect(published).toEqual(original);
  expect(values).toEqual(defaultValues(original.fields));
});
it("closes the style picker with Escape or outside click without applying an unconfirmed option, and supports keyboard choice", async () => {
  const { tabs } = fixture();
  const changes = vi.fn();
  const host = await mount(() =>
    h(TabFieldInspector, {
      field: tabs,
      schema: emptySchema(),
      applySchema: vi.fn(),
      onUpdate: changes,
    }),
  );
  const trigger = host.querySelector<HTMLButtonElement>(
    '[aria-label="标签页样式"]',
  )!;
  trigger.focus();
  trigger.click();
  await flush();
  const selected = document.querySelector<HTMLButtonElement>(
    '[role="option"][aria-selected="true"]',
  )!;
  expect(selected.getAttribute("aria-label")).toBe("标签页样式 3");
  selected.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(
    (document.activeElement as HTMLElement).getAttribute("aria-label"),
  ).toBe("标签页样式 5");
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(changes).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  trigger.click();
  await flush();
  document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  await flush();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(changes).not.toHaveBeenCalled();
  trigger.click();
  await flush();
  document
    .querySelector<HTMLButtonElement>(
      '[role="option"][aria-label="标签页样式 1"]',
    )!
    .click();
  await flush();
  expect(changes).toHaveBeenLastCalledWith({ tabStyle: "line" });
});
it("uses shared appearance in designer and runtime without changing the current tab or field values when color changes", async () => {
  const { schema, tabs } = fixture();
  const state = reactive({ schema, values: defaultValues(schema.fields) });
  const host = await mount(() =>
    h("div", [
      h(FieldCanvas, { fields: state.schema.fields, selectedIds: [] }),
      h(FormFields, {
        schema: state.schema,
        fields: state.schema.fields,
        values: state.values,
      }),
    ]),
  );
  const bars = () => [
    ...host.querySelectorAll<HTMLElement>('[role="tablist"]'),
  ];
  expect(bars().length).toBe(2);
  expect(bars().every((bar) => bar.classList.contains("tab-style-card"))).toBe(
    true,
  );
  bars()[1]!.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click();
  await flush();
  const original = copy(state.values);
  state.schema.fields[0]!.tabStyle = "top";
  state.schema.fields[0]!.tabCustomColor = true;
  state.schema.fields[0]!.tabColor = "#123456";
  await flush();
  expect(bars().every((bar) => bar.classList.contains("tab-style-top"))).toBe(
    true,
  );
  expect(
    host
      .querySelectorAll<HTMLElement>(".form-tab-shell")[1]!
      .style.getPropertyValue("--form-tab-accent"),
  ).toBe("#123456");
  expect(
    bars()[1]!.querySelector('[aria-selected="true"]')?.textContent,
  ).toContain("审批意见");
  expect(state.values).toEqual(original);
  state.schema.fields[0]!.tabCustomColor = false;
  await flush();
  expect(
    host
      .querySelectorAll<HTMLElement>(".form-tab-shell")[1]!
      .style.getPropertyValue("--form-tab-accent"),
  ).toBe("");
});
it("passes the existing external button color as an inherited theme and lets an enabled tab color override it", async () => {
  const { schema, tabs } = fixture();
  const state = reactive({ custom: customStyleFromTheme(4), tabs });
  state.custom.buttonColor = "#3158ab";
  const host = await mount(() =>
    h(
      ExternalFormFrame,
      { appearance: { theme: 4, custom: state.custom }, title: "申请" },
      () =>
        h(FormTabBar, {
          items: state.tabs.tabs,
          label: "分组",
          variant: "runtime",
          appearance: state.tabs,
        }),
    ),
  );
  expect(
    host
      .querySelector<HTMLElement>(".external-form")!
      .style.getPropertyValue("--form-tab-theme"),
  ).toBe("#3158ab");
  state.tabs.tabCustomColor = true;
  state.tabs.tabColor = "#ab3158";
  await flush();
  expect(
    host
      .querySelector<HTMLElement>(".form-tab-shell")!
      .style.getPropertyValue("--form-tab-accent"),
  ).toBe("#ab3158");
  state.tabs.tabCustomColor = false;
  state.custom.buttonColor = "#5865f5";
  await flush();
  expect(
    host
      .querySelector<HTMLElement>(".form-tab-shell")!
      .style.getPropertyValue("--form-tab-accent"),
  ).toBe("");
  expect(
    host
      .querySelector<HTMLElement>(".external-form")!
      .style.getPropertyValue("--form-tab-theme"),
  ).toBe("#5865f5");
  expect(schema.fields[0]!.children).toEqual(state.tabs.children);
});

it("positions the shared color panel using its actual height so bottom controls stay reachable", async () => {
  vi.stubGlobal("innerHeight", 720);
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return (
        this.classList.contains("option-color-panel")
          ? {
              x: 900,
              y: 0,
              left: 900,
              top: 0,
              right: 1184,
              bottom: 276,
              width: 284,
              height: 276,
            }
          : {
              x: 900,
              y: 420,
              left: 900,
              top: 420,
              right: 930,
              bottom: 449,
              width: 30,
              height: 29,
            }
      ) as DOMRect;
    });
  const host = await mount(() =>
    h(OptionColorPicker, {
      color: "#123456",
      label: "标签页",
    }),
  );
  host.querySelector<HTMLButtonElement>("button")!.click();
  await flush();
  const panel = document.querySelector<HTMLElement>(".option-color-panel")!;
  expect(Number.parseFloat(panel.style.top) + 276).toBeLessThanOrEqual(712);
  expect(panel.style.top).toBe("140px");
  expect(panel.querySelector('[aria-label="标签页自定义颜色"]')).not.toBeNull();
  rect.mockRestore();
});
