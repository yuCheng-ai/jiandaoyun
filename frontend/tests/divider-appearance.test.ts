// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive, shallowRef, triggerRef } from "vue";
import { createPinia } from "pinia";
import { composeFormSchema, separateFormSchema } from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  prepareSubmission,
} from "../src/domain/form";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
} from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import FieldInspector from "../src/features/forms/components/FieldInspector.vue";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import FormFields from "../src/features/forms/components/FormFields.vue";

const cleanup: (() => void)[] = [];
async function flush() {
  for (let i = 0; i < 6; i++) await nextTick();
}
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
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
  schema.fields = [
    createField("divider", {
      id: "section",
      label: "申请信息",
      dividerStyle: undefined,
      dividerColor: undefined,
      dividerTitleColor: undefined,
    }),
    createField("text", { id: "name", label: "申请人" }),
  ];
  return schema;
}
it("persists separate decoration and title colors only in page appearance, preserving values, field identity and missing historical colors", () => {
  const schema = fixture(),
    historical = copy(schema),
    model = separateFormSchema(schema).model;
  Object.assign(schema.fields[0]!, {
    dividerColor: "#2f7deb",
    dividerTitleColor: "#485970",
  });
  expect(parseSchema(copy(schema))).toEqual(schema);
  const split = separateFormSchema(schema);
  expect(split.model).toEqual(model);
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  expect(
    prepareSubmission(schema, { name: "合成申请人", section: "不是业务值" }),
  ).toEqual({ name: "合成申请人" });
  expect(parseSchema(historical)).toEqual(historical);
  expect(historical.fields[0]!.dividerColor).toBeUndefined();
  expect(historical.fields[0]!.dividerTitleColor).toBeUndefined();
});
it("rejects unsafe or malformed colors at import and publication, including appearance attached to an ordinary field", () => {
  for (const key of ["dividerColor", "dividerTitleColor"] as const) {
    for (const value of [
      "red;position:fixed",
      "url(https://invalid)",
      "#fff",
      "",
      123,
      null,
    ]) {
      const schema = fixture();
      Object.assign(schema.fields[0]!, { [key]: value });
      expect(() => parseSchema(schema)).toThrow(/分割线/);
      expect(
        validateFieldConfiguration(schema, seedWorkspace()).some((error) =>
          error.includes("分割线"),
        ),
      ).toBe(true);
    }
    const schema = fixture();
    Object.assign(schema.fields[1]!, { [key]: "#123456" });
    expect(() => parseSchema(schema)).toThrow(/只能用于分割线/);
    expect(
      validateFieldConfiguration(schema, seedWorkspace()).some((error) =>
        error.includes("只能用于分割线"),
      ),
    ).toBe(true);
  }
});
it("renders the same appearance in design and filling, keeps hidden titles blank and does not change business values", async () => {
  const schema = reactive(fixture()),
    values = { name: "合成申请人" };
  const host = await mount(() =>
    h("main", [
      h(FieldCanvas, { fields: schema.fields, selectedIds: [] }),
      h(FormFields, { schema, fields: schema.fields, values }),
    ]),
  );
  const dividers = () => [
    ...host.querySelectorAll<HTMLElement>(".runtime-divider"),
  ];
  for (const divider of dividers()) {
    expect(divider.style.getPropertyValue("--divider-color")).toBe("#e0e5eb");
    expect(divider.style.getPropertyValue("--divider-title-color")).toBe(
      "#949eac",
    );
  }
  Object.assign(schema.fields[0]!, {
    dividerColor: "#2f7deb",
    dividerTitleColor: "#485970",
  });
  await flush();
  for (const divider of dividers()) {
    expect(divider.style.getPropertyValue("--divider-color")).toBe("#2f7deb");
    expect(divider.style.getPropertyValue("--divider-title-color")).toBe(
      "#485970",
    );
  }
  schema.fields[0]!.showLabel = false;
  await flush();
  expect(host.querySelectorAll(".runtime-divider > span")).toHaveLength(0);
  expect(values).toEqual({ name: "合成申请人" });
  // Preview must also remain safe before invalid draft configuration is rejected.
  schema.fields[0]!.dividerColor = "url(https://invalid)";
  await flush();
  expect(dividers()[0]!.style.getPropertyValue("--divider-color")).toBe(
    "#e0e5eb",
  );
});
it("changes each color through the original undo history, with Escape preserving the draft and published snapshots", async () => {
  const form = shallowRef<FormRecord>(
    reactive({
      ...newForm("oa", "分割线颜色验收"),
      schema: fixture(),
    }) as FormRecord,
  );
  const published = copy(form.value.schema);
  let editor!: ReturnType<typeof useFormDesigner>;
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup() {
      editor = useFormDesigner(form);
      editor.select("section");
      return () =>
        h(FieldInspector, {
          field: editor.selected.value!,
          schema: form.value.schema,
          formId: form.value.id,
          onUpdate: (patch: object) =>
            editor.transact(() => {
              Object.assign(editor.selected.value!, patch);
              triggerRef(form);
            }),
        });
    },
  });
  app.use(createPinia());
  app.mount(host);
  cleanup.push(() => app.unmount());
  await flush();
  const color = host.querySelector<HTMLButtonElement>(
    '[aria-label="分割线颜色"]',
  )!;
  color.focus();
  color.click();
  await flush();
  expect(document.querySelectorAll(".option-color-grid button")).toHaveLength(
    32,
  );
  expect(
    [...document.querySelectorAll(".option-color-grid button")]
      .slice(0, 8)
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([
    "颜色 #eb5050",
    "颜色 #fa8118",
    "颜色 #f0a800",
    "颜色 #d6c504",
    "颜色 #a2c204",
    "颜色 #6ac73c",
    "颜色 #46c26f",
    "颜色 #00b899",
  ]);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flush();
  expect(document.querySelector(".option-color-panel")).toBeNull();
  expect(form.value.schema).toEqual(published);
  expect(document.activeElement).toBe(color);
  color.click();
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="颜色 #2f7deb"]')!
    .click();
  await flush();
  expect(form.value.schema.fields[0]!.dividerColor).toBe("#2f7deb");
  expect(form.value.schema.fields[0]!.dividerTitleColor).toBeUndefined();
  color.click();
  await flush();
  expect(document.querySelector(".option-custom-color")).toBeNull();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flush();
  const title = host.querySelector<HTMLButtonElement>(
    '[aria-label="分割线标题颜色"]',
  )!;
  title.focus();
  title.click();
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="分割线标题自定义颜色"]')!
    .click();
  await flush();
  const custom = document.querySelector<HTMLInputElement>(
    '[aria-label="分割线标题 HEX"]',
  )!;
  custom.value = "#123456";
  custom.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  expect(form.value.schema.fields[0]!.dividerTitleColor).toBeUndefined();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flush();
  expect(form.value.schema.fields[0]!.dividerTitleColor).toBe("#123456");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flush();
  expect(document.activeElement).toBe(title);
  title.click();
  await flush();
  expect(
    document.querySelector('[aria-label="自定义颜色 #123456"]'),
  ).not.toBeNull();
  expect(
    document.querySelector<HTMLElement>(
      '[aria-label="自定义颜色 #123456"] .option-color-dot',
    )!.style.backgroundColor,
  ).toBe("rgb(18, 52, 86)");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flush();
  editor.undo();
  triggerRef(form);
  await flush();
  expect(form.value.schema.fields[0]!.dividerTitleColor).toBeUndefined();
  expect(form.value.schema.fields[0]!.dividerColor).toBe("#2f7deb");
  editor.redo();
  triggerRef(form);
  await flush();
  expect(form.value.schema.fields[0]!.dividerTitleColor).toBe("#123456");
  expect(parseSchema(form.value.schema).fields[0]!.id).toBe("section");
  expect(form.value.schema.fields[1]).toEqual(published.fields[1]);
  expect(published).toEqual(fixture());
});
it("removes a field's open palette when selecting another field instead of applying a color to the wrong field", async () => {
  const schema = reactive(fixture()),
    selection = reactive({ index: 0 }),
    changes: object[] = [];
  const host = await mount(() =>
    h(FieldInspector, {
      field: schema.fields[selection.index]!,
      schema,
      formId: "form",
      onUpdate: (patch: object) => changes.push(patch),
    }),
  );
  host.querySelector<HTMLButtonElement>('[aria-label="分割线颜色"]')!.click();
  await flush();
  expect(document.querySelector(".option-color-panel")).not.toBeNull();
  selection.index = 1;
  await flush();
  expect(document.querySelector(".option-color-panel")).toBeNull();
  expect(host.querySelector('[aria-label="分割线颜色"]')).toBeNull();
  expect(changes).toEqual([]);
  expect(schema).toEqual(fixture());
});
