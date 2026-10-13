// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
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
import { seedWorkspace } from "../src/domain/workspace";

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
