// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  separateFormSchema,
  composeFormSchema,
  externalStyleErrors,
  externalImageIssue,
  type CustomExternalStyle,
  type ExternalFormStyle,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  copy,
} from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";
import { fillingSession } from "../src/domain/fillingSession";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});

function customStyle(): CustomExternalStyle {
  return {
    background: { type: "color", color: "#ffffff" },
    header: { type: "image", color: "#ffffff", image: 4 },
    title: {
      visible: true,
      align: "left",
      size: 20,
      bold: true,
      italic: false,
      underline: false,
      color: "#131d2e",
    },
    buttonColor: "#03aba0",
  };
}

it("custom settings survive page projection, rejecting malformed nested styles and unsafe image references", () => {
  const schema = fixture();
  schema.settings.externalStyle = { theme: 4, custom: customStyle() };
  expect(externalStyleErrors(schema.settings)).toEqual([]);
  const split = separateFormSchema(schema);
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  for (const index of [0, 1, 4, 22]) {
    schema.settings.externalStyle = {
      theme: index,
      custom: customStyle(),
    };
    expect(parseSchema(copy(schema))).toEqual(schema);
  }
  const original = customStyle();
  const invalid = [
    null,
    {},
    { ...original, extra: true },
    {
      ...original,
      background: { type: "color", color: "url(https://unknown)" },
    },
    { ...original, background: { type: "image", color: "#ffffff", image: 1 } },
    {
      ...original,
      header: { type: "image", color: "#ffffff", image: "https://unknown" },
    },
    {
      ...original,
      header: {
        type: "image",
        color: "#ffffff",
        image: {
          id: "file_" + "a".repeat(36),
          name: "image.svg",
          size: 10,
          type: "image/svg+xml",
        },
      },
    },
    { ...original, title: { ...original.title, visible: "true" } },
    { ...original, title: { ...original.title, size: 1000 } },
    { ...original, buttonColor: "red;position:fixed" },
  ];
  for (const custom of invalid)
    expect(() =>
      parseSchema({
        ...schema,
        settings: { ...schema.settings, externalStyle: { theme: 4, custom } },
      }),
    ).toThrow(/外链样式/);
  expect(
    externalImageIssue({
      name: "图.PNG",
      type: "image/png",
      size: 5 * 1024 * 1024,
    }),
  ).toBeUndefined();
  expect(
    externalImageIssue({
      name: "图.png",
      type: "image/png",
      size: 5 * 1024 * 1024 + 1,
    }),
  ).toContain("5 MB");
});
it("custom publication and refresh leave older themes, records and fields immutable", async () => {
  const store = useWorkspaceStore();
  const created = (await store.createForm("oa", "自定义验收", "form"))!;
  const form = store.openForm(created.id)!;
  form.schema = fixture();
  form.schema.settings.externalStyle = { theme: 1 };
  expect(await store.publishForm(form.id)).toBe(true);
  const old = copy((await store.submitEntry(form.id, { name: "旧记录" }))!),
    v1 = copy(form.versions[0]);
  const appearance: ExternalFormStyle = {
    theme: 4,
    custom: customStyle(),
  };
  appearance.custom!.title.align = "right";
  appearance.custom!.title.visible = false;
  appearance.custom!.buttonColor = "#123456";
  form.schema.settings.externalStyle = appearance;
  expect(await store.publishForm(form.id)).toBe(true);
  setActivePinia(createPinia());
  const fresh = useWorkspaceStore(),
    saved = fresh.data.forms.find((f) => f.id === form.id)!;
  expect(saved.published!.schema.settings.externalStyle).toEqual(appearance);
  expect(saved.versions[0]).toEqual(v1);
  expect(fresh.data.entries.find((e) => e.id === old.id)).toEqual(old);
  expect(saved.schema.fields.map((f) => f.id)).toEqual(["name"]);
});
function fixture() {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "name", label: "姓名", required: true }),
  ];
  return schema;
}

it("theme settings survive parsing and page projection; malformed styles are never silently dropped", () => {
  const original = fixture();
  original.settings.externalStyle = { theme: 22 };
  const restored = parseSchema(copy(original)),
    split = separateFormSchema(restored);
  expect(composeFormSchema(split.model, split.page)).toEqual(restored);
  expect(parseSchema(fixture()).settings.externalStyle).toBeUndefined();
  for (const style of [
    null,
    [],
    { theme: -1 },
    { theme: 23 },
    { theme: "2" },
    { theme: 1.5 },
    { theme: 1, image: "https://unknown" },
  ]) {
    expect(() =>
      parseSchema({
        ...original,
        settings: { ...original.settings, externalStyle: style },
      }),
    ).toThrow(/外链样式/);
  }
});
it("save, reload and publication retain themes, stable fields, pinned drafts and old records", async () => {
  const store = useWorkspaceStore();
  const created = (await store.createForm("oa", "主题验收", "form"))!;
  const form = store.openForm(created.id)!;
  form.schema = fixture();
  form.schema.settings.externalStyle = { theme: 1 };
  expect(await store.publishForm(form.id)).toBe(true);
  const old = (await store.submitEntry(form.id, { name: "旧记录" }))!;
  const draft = (await store.submitEntry(
    form.id,
    { name: "原草稿" },
    "draft",
  ))!;
  const original = copy(old),
    version = copy(form.versions[0]);
  form.schema.settings.externalStyle = { theme: 4 };
  expect(await store.publishForm(form.id)).toBe(true);
  setActivePinia(createPinia());
  const fresh = useWorkspaceStore();
  const saved = fresh.data.forms.find((f) => f.id === form.id)!;
  expect(saved.published!.schema.settings.externalStyle).toEqual({ theme: 4 });
  expect(saved.versions[0]).toEqual(version);
  expect(fresh.data.entries.find((e) => e.id === old.id)).toEqual(original);
  expect(saved.published!.schema.fields.map((f) => f.id)).toEqual(["name"]);
  expect(
    fillingSession(
      fresh.data,
      form.id,
      draft.id,
      fresh.data.organization.currentUserId,
    ).definition!.schema.settings.externalStyle,
  ).toEqual({ theme: 1 });
});
