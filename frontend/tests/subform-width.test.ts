// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import {
  composeFormSchema,
  separateFormSchema,
  subformColumnWidth,
  subformWidthErrors,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  copy,
} from "../src/domain/form";
import { seedWorkspace } from "../src/domain/workspace";

import { validateFieldConfiguration } from "../src/domain/fieldValidation";

import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import FormFields from "../src/features/forms/components/FormFields.vue";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.innerHTML = "";
});
const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick();
};
function fixture() {
  const schema = emptySchema();
  schema.fields = [
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("text", {
          id: "code",
          label: "编号",
          subformWidth: "half",
        }),
        createField("number", {
          id: "qty",
          label: "数量",
          subformWidth: "double",
        }),
        createField("text", { id: "note", label: "备注", subformWidth: 320 }),
      ],
    }),
  ];
  return schema;
}
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

it("resolves four subfield modes independently of main grid widths and rejects invalid pixels", () => {
  expect(
    [undefined, "standard", "half", "double", 320, 1000].map((subformWidth) =>
      subformColumnWidth({ subformWidth } as any),
    ),
  ).toEqual([200, 200, 100, 400, 320, 1000]);
  for (const subformWidth of [
    0,
    -1,
    1001,
    20.5,
    NaN,
    Infinity,
    "custom",
    "320",
    null,
    {},
  ])
    expect(subformWidthErrors({ subformWidth } as any)).toHaveLength(1);
  expect(subformColumnWidth(createField("text", { width: 3 }))).toBe(200);
});

it("round-trips widths as presentation, preserves old schemas and refuses malformed imports", () => {
  const schema = fixture(),
    split = separateFormSchema(schema);
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  expect(split.model.fields[0]!.children[0]!.settings).not.toHaveProperty(
    "subformWidth",
  );
  expect(split.page.controls[0]!.children[0]!.properties.subformWidth).toBe(
    "half",
  );
  expect(parseSchema(schema)).toEqual(schema);
  for (const child of schema.fields[0]!.children) delete child.subformWidth;
  expect(parseSchema(schema)).toEqual(schema);
  expect(parseSchema(schema).fields[0]!.children[0]).not.toHaveProperty(
    "subformWidth",
  );
  schema.fields[0]!.children[0]!.subformWidth = 1001;
  expect(() => parseSchema(schema)).toThrow("子字段宽度");
  expect(validateFieldConfiguration(schema, seedWorkspace()).join()).toContain(
    "子字段宽度",
  );
});

it("updates design and runtime columns together, excludes hidden columns and keeps row values and IDs", async () => {
  const schema = reactive(fixture()),
    values = { lines: [{ code: "A", qty: 0, note: "合成备注" }] },
    original = copy(values);
  const mode = reactive({
    disabled: false,
    device: "desktop" as "desktop" | "mobile",
  });
  const host = await mount(() =>
    h("main", [
      h(FieldCanvas, { fields: schema.fields, selectedIds: [] }),
      h(FormFields, { fields: schema.fields, schema, values, ...mode }),
    ]),
  );
  const columns = () =>
    [
      ...host.querySelectorAll<HTMLElement>(
        ".subform-columns > .field-design-slot",
      ),
    ].map((slot) => slot.style.flexBasis);
  const runtime = () =>
    [...host.querySelectorAll<HTMLElement>("colgroup col")].map(
      (col) => col.style.width,
    );
  expect(columns()).toEqual(["100px", "400px", "320px"]);
  expect(runtime()).toEqual(["45px", "100px", "400px", "320px", "72px"]);
  schema.fields[0]!.children[1]!.visible = false;
  schema.fields[0]!.children[2]!.subformWidth = 1000;
  mode.disabled = true;
  mode.device = "mobile";
  await flush();
  expect(columns()).toEqual(["100px", "400px", "1000px"]);
  expect(runtime()).toEqual(["45px", "100px", "1000px"]);
  expect(host.querySelector<HTMLTableElement>("table")!.style.width).toBe(
    "1145px",
  );
  expect(host.querySelectorAll("tbody input")).toHaveLength(2);
  expect(values).toEqual(original);
});
