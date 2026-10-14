// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import {
  defaultMobileLayout,
  formTitleLayout,
  separateFormSchema,
  composeFormSchema,
} from "@platform/contracts";
import {
  emptySchema,
  createField,
  parseSchema,
  copy,
} from "../src/domain/form";
import { newForm } from "../src/domain/workspace";

import FormFields from "../src/features/forms/components/FormFields.vue";
import FormPreview from "../src/features/forms/components/FormPreview.vue";

let pinia = createPinia();
const cleanup: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const schema = emptySchema();
  schema.fields = [
    createField("text", {
      id: "name",
      label: "申请人",
      description: "<p>填写申请人姓名</p>",
    }),
  ];
  Object.assign(schema.settings, {
    layout: 4,
    labelPosition: "left",
    labelWidth: 80,
    labelAlignment: "right",
    descriptionMode: "popover",
    inputWidth: "auto",
    mobileLayout: defaultMobileLayout(),
  });
  return schema;
}
async function mount(component: any, props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const app = createApp({ render: () => h(component, props) });
  app.use(pinia);
  app.use(router);
  app.mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  return host;
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  )!;
async function click(label: string) {
  button(label).click();
  await nextTick();
  await nextTick();
}

it("historical forms keep mobile top titles and ordinary forms start with the source defaults", () => {
  const old = emptySchema();
  old.settings.labelPosition = "left";
  expect(formTitleLayout(parseSchema(old).settings, true)).toEqual(
    defaultMobileLayout(),
  );
  expect(parseSchema(old).settings.mobileLayout).toBeUndefined();
  expect(newForm("oa", "新表").schema.settings).toMatchObject({
    labelWidth: 80,
    inputWidth: "standard",
    mobileLayout: defaultMobileLayout(),
  });
  expect(
    newForm("oa", "流程", "workflow").schema.settings.mobileLayout,
  ).toBeUndefined();
});
it("four columns and independent device layouts survive reload and existing page projection without changing bindings", () => {
  const original = fixture(),
    restored = parseSchema(copy(original));
  expect(restored.settings).toMatchObject(original.settings);
  const split = separateFormSchema(restored),
    composed = composeFormSchema(split.model, split.page);
  expect(composed.settings).toMatchObject(restored.settings);
  expect(composed.fields.map((field) => field.id)).toEqual(["name"]);
});
it("malformed optional device settings are rejected rather than silently removed", () => {
  for (const changes of [
    { inputWidth: "wide" },
    { labelAlignment: "center" },
    { descriptionMode: "none" },
    { mobileLayout: null },
    { mobileLayout: [] },
    { mobileLayout: { ...defaultMobileLayout(), labelWidth: 501 } },
    { mobileLayout: { ...defaultMobileLayout(), labelWidth: 70.5 } },
    { mobileLayout: { ...defaultMobileLayout(), labelPosition: "side" } },
  ]) {
    expect(() =>
      parseSchema({
        ...fixture(),
        settings: { ...fixture().settings, ...changes },
      }),
    ).toThrow(/布局/);
  }
});
it("subform descriptions remain reachable without rows and respect hidden columns", async () => {
  const schema = emptySchema();
  schema.fields = [
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("text", {
          id: "product",
          label: "商品",
          description:
            '<p><b>填写商品规格</b><a href="https://example.com/guide">规格说明</a><img src="data:image/png;base64,iVBORw0KGgo=" alt="规格示意图" onerror="alert(1)"></p>',
        }),
        createField("text", {
          id: "secret",
          label: "内部",
          visible: false,
          description: "内部说明不应显示",
        }),
      ],
    }),
  ];
  const props = reactive({
    schema,
    fields: schema.fields,
    values: { lines: [] },
    device: "desktop" as "desktop" | "mobile",
  });
  const host = await mount(FormFields, props);
  expect(button("查看商品的描述")).toBeDefined();
  expect(button("查看内部的描述")).toBeUndefined();
  await click("查看商品的描述");
  let popup = document.querySelector<HTMLElement>(
    ".field-description-popover",
  )!;
  expect(popup.querySelector("b")!.textContent).toBe("填写商品规格");
  expect(popup.querySelector("a")!.getAttribute("href")).toBe(
    "https://example.com/guide",
  );
  expect(popup.querySelector("img")!.getAttribute("alt")).toBe("规格示意图");
  expect(popup.querySelector("[onerror]")).toBeNull();
  popup.dispatchEvent(new Event("scroll"));
  await nextTick();
  expect(document.querySelector(".field-description-popover")).toBe(popup);
  host.dispatchEvent(new Event("scroll"));
  await nextTick();
  expect(document.querySelector(".field-description-popover")).toBeNull();
  props.device = "mobile";
  await nextTick();
  await click("查看商品的描述");
  popup = document.querySelector<HTMLElement>(".field-description-popover")!;
  expect(popup.textContent).toContain("填写商品规格");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await nextTick();
  await nextTick();
  expect(document.querySelector(".field-description-popover")).toBeNull();
  expect(document.activeElement).toBe(button("查看商品的描述"));
});

it("device rendering shares values, shows divider descriptions and uses an accessible sanitized popover", async () => {
  const schema = fixture();
  schema.fields.push(
    createField("divider", {
      id: "section",
      label: "说明",
      description: "始终显示",
    }),
  );
  schema.fields[0]!.description += '<img src=x onerror="alert(1)">';
  const values = { name: "李四" },
    props = reactive({
      schema,
      fields: schema.fields,
      values,
      device: "desktop" as "desktop" | "mobile",
    });
  const host = await mount(FormFields, props);
  expect(
    host.querySelector(".runtime-fields")!.classList.contains("labels-right"),
  ).toBe(true);
  expect(
    host.querySelector(
      '.runtime-field[data-field-id="name"] .field-description',
    ),
  ).toBeNull();
  expect(
    host.querySelector(".divider-field .field-description")!.textContent,
  ).toBe("始终显示");
  await click("查看申请人的描述");
  const popup = document.querySelector<HTMLElement>(
    ".field-description-popover",
  )!;
  expect(popup.textContent).toContain("填写申请人姓名");
  expect(popup.querySelector("[onerror]")).toBeNull();
  popup.dispatchEvent(new Event("scroll"));
  await nextTick();
  expect(document.querySelector(".field-description-popover")).toBe(popup);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await nextTick();
  await nextTick();
  expect(document.querySelector(".field-description-popover")).toBeNull();
  expect(document.activeElement).toBe(button("查看申请人的描述"));
  props.device = "mobile";
  await nextTick();
  expect(
    host.querySelector(".runtime-fields")!.classList.contains("is-mobile"),
  ).toBe(true);
  expect(
    host.querySelector(".runtime-fields")!.classList.contains("labels-left"),
  ).toBe(false);
  expect(
    host.querySelector(
      '.runtime-field[data-field-id="name"] .field-description',
    ),
  ).not.toBeNull();
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="申请人"]')!.value,
  ).toBe("李四");
  expect(values).toEqual({ name: "李四" });
});
it("actual narrow screens follow mobile configuration and unregister their media listener", async () => {
  let listener: (() => void) | undefined;
  const media = {
    matches: false,
    addEventListener: vi.fn((_event, fn) => {
      listener = fn;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  const schema = fixture(),
    host = await mount(FormFields, {
      schema,
      fields: schema.fields,
      values: {},
    });
  expect(
    host.querySelector(".runtime-fields")!.classList.contains("labels-left"),
  ).toBe(true);
  media.matches = true;
  listener!();
  await nextTick();
  expect(
    host.querySelector(".runtime-fields")!.classList.contains("labels-left"),
  ).toBe(false);
  cleanup.pop()!();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
});
it("nested tabs inherit the selected device instead of the browser width", async () => {
  const schema = fixture(),
    tabs = createField("tabs", { id: "tabs" });
  tabs.children = [
    createField("text", { id: "nested", tabId: tabs.tabs[0]!.id }),
  ];
  schema.fields = [tabs];
  const host = await mount(FormFields, {
    schema,
    fields: schema.fields,
    values: {},
    device: "mobile",
  });
  expect(host.querySelectorAll(".runtime-fields.is-mobile")).toHaveLength(2);
  expect(host.querySelectorAll(".runtime-fields.labels-left")).toHaveLength(0);
  schema.fields[0]!.description = "部门填写说明";
  schema.settings.mobileLayout = {
    ...defaultMobileLayout(),
    labelPosition: "left",
    descriptionMode: "popover",
  };
  cleanup.pop()!();
  await mount(FormFields, {
    schema,
    fields: schema.fields,
    values: {},
    device: "mobile",
  });
  expect(button(`查看${tabs.label}的描述`)).toBeDefined();
  await click(`查看${tabs.label}的描述`);
  expect(
    document.querySelector(".field-description-popover")!.textContent,
  ).toContain("部门填写说明");
});
it("switching actual preview devices retains entered values without remounting the runtime", async () => {
  await mount(FormPreview, {
    schema: fixture(),
    formId: "layout-preview",
    title: "布局",
  });
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="申请人"]',
  )!;
  input.value = "王五";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await click("手机预览");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="申请人"]')!
      .value,
  ).toBe("王五");
  expect(
    document.querySelector(".runtime-fields")!.classList.contains("is-mobile"),
  ).toBe(true);
  await click("电脑预览");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="申请人"]')!
      .value,
  ).toBe("王五");
});
