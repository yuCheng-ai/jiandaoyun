// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive, shallowRef, triggerRef } from "vue";
import { createPinia } from "pinia";
import { composeFormSchema, separateFormSchema } from "@platform/contracts";
import {
  copy,
  countFormFields,
  createField,
  emptySchema,
  findField,
  parseSchema,
  prepareSubmission,
} from "../src/domain/form";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
} from "../src/domain/workspace";
import {
  buildRecordBlocks,
  newPrintTemplate,
  presentationFields,
} from "../src/domain/presentation";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import FieldInspector from "../src/features/forms/components/FieldInspector.vue";
import FormFields from "../src/features/forms/components/FormFields.vue";

const cleanups: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick();
};
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
});
async function mount(render: () => any) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render });
  app.use(createPinia());
  app.mount(host);
  cleanups.push(() => app.unmount());
  await flush();
  return host;
}
function fixture() {
  const schema = emptySchema();
  schema.settings.layout = 3;
  schema.fields = [
    createField("divider", {
      id: "section",
      width: 4,
      showLabel: false,
      label: "不显示的分区标题",
      description: '<p>填写说明<img src=x onerror="alert(1)"></p>',
    }),
    createField("text", { id: "name", label: "申请人", width: 4 }),
  ];
  return schema;
}
it("uses the same partial-row spacer, hidden title and sanitized description in design, desktop and mobile without changing values", async () => {
  const schema = reactive(fixture()),
    runtime = reactive({ device: "desktop" as "desktop" | "mobile" }),
    values = { name: "合成申请人" };
  const host = await mount(() =>
    h("main", [
      h(FieldCanvas, { fields: schema.fields, selectedIds: [], layout: 3 }),
      h(FormFields, {
        schema,
        fields: schema.fields,
        values,
        device: runtime.device,
      }),
    ]),
  );
  expect(
    host.querySelector<HTMLElement>(".field-design-slot")!.style.gridColumn,
  ).toBe("span 4");
  expect(host.querySelectorAll(".runtime-divider > span")).toHaveLength(0);
  expect(
    host
      .querySelector(".design-control-preview:has(.runtime-divider)")
      ?.classList.contains("full-preview"),
  ).toBe(true);
  for (const card of host.querySelectorAll(
    ".field-design-card:has(.runtime-divider), .divider-field",
  )) {
    expect(card.querySelector(".field-description")!.textContent).toBe(
      "填写说明",
    );
    expect(card.querySelector("[onerror]")).toBeNull();
    expect(
      card
        .querySelector(".runtime-divider")!
        .compareDocumentPosition(card.querySelector(".field-description")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  schema.fields[0]!.width = 12;
  schema.fields[0]!.showLabel = true;
  runtime.device = "mobile";
  await flush();
  expect(
    host.querySelector<HTMLElement>(".field-design-slot")!.style.gridColumn,
  ).toBe("span 12");
  expect(host.querySelectorAll(".runtime-divider .sep-label")).toHaveLength(2);
  expect(values).toEqual({ name: "合成申请人" });
});
it("keeps divider descriptions visible under hidden-title and popover layouts, while the visible permission removes the whole section", async () => {
  const schema = reactive(fixture());
  schema.settings.labelPosition = "left";
  schema.settings.descriptionMode = "popover";
  const host = await mount(() =>
    h(FormFields, { schema, fields: schema.fields, values: {} }),
  );
  expect(
    host.querySelector(".divider-field .field-description")!.textContent,
  ).toBe("填写说明");
  expect(
    host.querySelector(".divider-field button, .divider-field input"),
  ).toBeNull();
  schema.fields[0]!.visible = false;
  await flush();
  expect(host.querySelector(".divider-field")).toBeNull();
  expect(host.querySelector('input[aria-label="申请人"]')).not.toBeNull();
});
it("removes the unused edit permission and routes title and width settings through the original editor history", async () => {
  const form = shallowRef<FormRecord>({
    ...newForm("oa", "分割线验收"),
    schema: fixture(),
  });
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
  cleanups.push(() => app.unmount());
  await flush();
  expect(host.textContent).not.toContain("可编辑");
  expect(host.textContent).toContain("可见");
  const title = host.querySelector<HTMLInputElement>("#field-title")!;
  title.value = "新分区标题";
  title.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  [...host.querySelectorAll("button")]
    .find((b) => b.textContent?.trim() === "1/2")!
    .click();
  await flush();
  expect(findField(form.value.schema.fields, "section")).toMatchObject({
    label: "新分区标题",
    width: 6,
    showLabel: false,
    editable: true,
  });
  editor.undo();
  triggerRef(form);
  await flush();
  expect(findField(form.value.schema.fields, "section")!.width).toBe(4);
  editor.redo();
  triggerRef(form);
  await flush();
  expect(findField(form.value.schema.fields, "section")!.width).toBe(6);
  expect(parseSchema(form.value.schema).fields[0]!.id).toBe("section");
  expect(published.fields[0]!).toMatchObject({
    label: "不显示的分区标题",
    width: 4,
  });
});
it("allows dividers at the 300-field limit across adding, copying, restoring and parsing, including tab children", async () => {
  const schema = emptySchema(),
    tabs = createField("tabs", { id: "tabs" });
  tabs.children = [
    createField("divider", { id: "nested", tabId: tabs.tabs[0]!.id }),
  ];
  schema.fields = [
    ...Array.from({ length: 300 }, () => createField("text")),
    tabs,
  ];
  const form = shallowRef<FormRecord>({ ...newForm("oa", "数量验收"), schema });
  let editor!: ReturnType<typeof useFormDesigner>;
  const messages: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup() {
      editor = useFormDesigner(form, (m) => messages.push(m));
      return () => null;
    },
  });
  app.use(createPinia());
  app.mount(host);
  cleanups.push(() => app.unmount());
  const divider = editor.add("divider", null)!;
  expect(divider).toBeTruthy();
  editor.duplicate(divider.id);
  expect(countFormFields(form.value.schema.fields)).toBe(300);
  editor.remove([divider.id]);
  expect(editor.restore(0)).toBe(true);
  expect(editor.add("text", null)).toBeUndefined();
  expect(messages).toEqual(["单个表单最多 300 个字段"]);
  expect(parseSchema(copy(form.value.schema))).toEqual(form.value.schema);
  form.value.schema.fields.push(createField("text"));
  expect(() => parseSchema(form.value.schema)).toThrow("数量超限");
});
it("preserves old definitions and page roundtrips, but never submits or prints a divider as a data value", () => {
  const schema = fixture(),
    before = copy(schema),
    split = separateFormSchema(schema);
  expect(parseSchema(schema)).toEqual(before);
  expect(composeFormSchema(split.model, split.page)).toEqual(before);
  expect(schema).toEqual(before);
  const values = { name: "合成申请人", section: "旧值不写入" };
  expect(prepareSubmission(schema, values)).toEqual({ name: "合成申请人" });
  expect(values.section).toBe("旧值不写入");
  expect(presentationFields(schema).map((f) => f.id)).toEqual(["name"]);
  const template = newPrintTemplate(schema, "分割线验收");
  expect(template.fieldIds).toEqual(["name"]);
  expect(
    buildRecordBlocks(schema, values, template, seedWorkspace()).map(
      (b) => b.id,
    ),
  ).toEqual(["name"]);
});
