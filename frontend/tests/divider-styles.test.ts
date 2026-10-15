import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import {
  composeFormSchema,
  separateFormSchema,
  formDividerStyles,
} from "@platform/contracts";
import {
  copy,
  createField,
  duplicateField,
  emptySchema,
  parseSchema,
  prepareSubmission,
} from "../src/domain/form";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";

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
    createField("divider", { id: "section", label: "申请信息" }),
    createField("text", { id: "name", label: "申请人" }),
  ];
  return schema;
}
it("roundtrips every source style as page appearance, keeps old missing appearance and duplicate/new identities, and excludes decoration from business data", () => {
  expect(formDividerStyles).toHaveLength(13);
  const schema = fixture(),
    model = separateFormSchema(schema).model;
  expect(schema.fields[0]).toMatchObject({
    dividerStyle: "style1",
    dividerColor: "#00b899",
    dividerTitleColor: "#141e31",
  });
  for (const dividerStyle of formDividerStyles) {
    schema.fields[0]!.dividerStyle = dividerStyle;
    expect(parseSchema(copy(schema))).toEqual(schema);
    const split = separateFormSchema(schema);
    expect(split.model).toEqual(model);
    expect(composeFormSchema(split.model, split.page)).toEqual(schema);
    const duplicate = duplicateField(schema.fields[0]!);
    expect(duplicate.id).not.toBe("section");
    expect(duplicate.dividerStyle).toBe(dividerStyle);
    expect(
      prepareSubmission(schema, { name: "合成申请人", section: "旧装饰值" }),
    ).toEqual({ name: "合成申请人" });
  }
  const historical = copy(schema);
  delete historical.fields[0]!.dividerStyle;
  delete historical.fields[0]!.dividerColor;
  delete historical.fields[0]!.dividerTitleColor;
  expect(parseSchema(historical)).toEqual(historical);
  expect(parseSchema(historical).fields[0]!.dividerStyle).toBeUndefined();
});
it("rejects unrecognized styles at import/publication and any divider style on a business field", () => {
  for (const value of ["style10", "thin;position:fixed", "", null, 2, {}]) {
    const schema = fixture();
    Object.assign(schema.fields[0]!, { dividerStyle: value });
    expect(() => parseSchema(schema)).toThrow(/分割线样式/);
    expect(
      validateFieldConfiguration(schema, seedWorkspace()).some((e) =>
        e.includes("分割线样式"),
      ),
    ).toBe(true);
  }
  const schema = fixture();
  Object.assign(schema.fields[1]!, { dividerStyle: "thin" });
  expect(() => parseSchema(schema)).toThrow(/只能用于分割线/);
  expect(
    validateFieldConfiguration(schema, seedWorkspace()).some((e) =>
      e.includes("只能用于分割线"),
    ),
  ).toBe(true);
});
it("uses each skin in design and filling with the same title/color, preserves readonly business values, and hides the complete decoration when its title is off", async () => {
  const schema = reactive(fixture()),
    values = { name: "合成申请人" };
  const host = await mount(() =>
    h("main", [
      h(FieldCanvas, { fields: schema.fields, selectedIds: [] }),
      h(FormFields, { schema, fields: schema.fields, values, readonly: true }),
    ]),
  );
  for (const style of formDividerStyles) {
    schema.fields[0]!.dividerStyle = style;
    await flush();
    const dividers = [
      ...host.querySelectorAll<HTMLElement>(".runtime-divider"),
    ];
    expect(dividers).toHaveLength(2);
    for (const divider of dividers) {
      expect(divider.querySelector(`.sep-line.${style}`)).not.toBeNull();
      expect(divider.textContent).toContain("申请信息");
      expect(divider.querySelector("input, textarea, button")).toBeNull();
      expect(divider.style.getPropertyValue("--divider-color")).toBe("#00b899");
    }
    schema.fields[0]!.showLabel = false;
    await flush();
    for (const divider of host.querySelectorAll(".runtime-divider")) {
      expect(divider.textContent).toBe("");
      expect(divider.querySelector(".sep-line")).toBeNull();
    }
    schema.fields[0]!.showLabel = true;
  }
  schema.fields[0]!.visible = false;
  await flush();
  expect(host.querySelector(".divider-field")).toBeNull();
  expect(values).toEqual({ name: "合成申请人" });
});
