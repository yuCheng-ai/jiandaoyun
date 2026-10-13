// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
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
import OptionColorPicker from "../src/components/OptionColorPicker.vue";
import FormTabBar from "../src/features/forms/components/FormTabBar.vue";
import FormFields from "../src/features/forms/components/FormFields.vue";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";

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
