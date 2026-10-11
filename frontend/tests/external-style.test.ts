// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import {
  externalThemeCount,
  separateFormSchema,
  composeFormSchema,
  externalStyleErrors,
  externalImageIssue,
  type ExternalFormStyle,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  copy,
} from "../src/domain/form";
import { externalThemes } from "../src/domain/externalThemes";
import { customStyleFromTheme } from "../src/domain/externalStyle";
import * as fileRepository from "../src/repositories/fileRepository";
import ExternalStyleImageControl from "../src/features/forms/components/ExternalStyleImageControl.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import { fillingSession } from "../src/domain/fillingSession";
import FormExternalStyleSettings from "../src/features/forms/components/FormExternalStyleSettings.vue";
import ExternalFormFrame from "../src/features/forms/components/ExternalFormFrame.vue";

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
it("custom settings preserve presets and page projection, rejecting malformed nested styles and unsafe image references", () => {
  const schema = fixture();
  schema.settings.externalStyle = { theme: 4, custom: customStyleFromTheme(4) };
  expect(externalStyleErrors(schema.settings)).toEqual([]);
  const split = separateFormSchema(schema);
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  for (const index of [0, 1, 4, 22]) {
    schema.settings.externalStyle = {
      theme: index,
      custom: customStyleFromTheme(index),
    };
    expect(parseSchema(copy(schema))).toEqual(schema);
  }
  const original = customStyleFromTheme(4);
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
it("custom title/color controls affect the shared frame, keep input and close nested palettes before the parent", async () => {
  const schema = reactive(fixture());
  schema.settings.externalStyle = { theme: 5 };
  await mount(FormExternalStyleSettings, {
    schema,
    title: "报名",
    formId: "qa",
  });
  await click("表单外链样式设置");
  const name = document.querySelector<HTMLInputElement>('[aria-label="姓名"]')!;
  name.value = "保留输入";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await click("自定义样式");
  const custom = schema.settings.externalStyle.custom!;
  expect(custom.header.image).toBe(5);
  await click("标题居中");
  await click("标题加粗");
  await click("标题斜体");
  await click("标题下划线");
  const size = document.querySelector<HTMLSelectElement>(
    '[aria-label="标题字号"]',
  )!;
  size.value = "28";
  size.dispatchEvent(new Event("change", { bubbles: true }));
  await click("提交按钮颜色");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await nextTick();
  await nextTick();
  expect(document.querySelector(".option-color-panel")).toBeNull();
  expect(document.querySelector(".external-style-dialog")).not.toBeNull();
  expect(document.activeElement).toBe(button("提交按钮颜色"));
  await click("提交按钮颜色");
  await click("颜色 #eb5050");
  expect(custom.buttonColor).toBe("#eb5050");
  expect(
    document
      .querySelector<HTMLElement>(".external-form")!
      .style.getPropertyValue("--external-button"),
  ).toBe("#eb5050");
  const title = document.querySelector<HTMLElement>(".external-form-head h2")!;
  expect(title.style.textAlign).toBe("center");
  expect(title.style.fontWeight).toBe("400");
  expect(title.style.fontSize).toBe("28px");
  expect(title.style.fontStyle).toBe("italic");
  expect(title.style.textDecoration).toBe("underline");
  await click("隐藏标题");
  expect(document.querySelector(".external-form-head h2")).toBeNull();
  await click("显示标题");
  await click("手机外链预览");
  await click("主题样式");
  await click("自定义样式");
  expect(custom.title.size).toBe(28);
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="姓名"]')!.value,
  ).toBe("保留输入");
  await click("主题样式");
  await click("主题2");
  expect(schema.settings.externalStyle).toEqual({ theme: 2 });
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="姓名"]')!.value,
  ).toBe("保留输入");
});

function fileDatabase() {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:qa-${crypto.randomUUID()}`);
      static revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      async decode() {}
    },
  );
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await nextTick();
  await nextTick();
}
async function upload(files: File[], complete = true) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  if (complete)
    await vi.waitFor(() =>
      expect(
        document.querySelector('.external-style-image[aria-busy="false"]'),
      ).not.toBeNull(),
    );
}
it("uploads commit to the shared file repository, preserve the previous image on failures and remove only the style reference", async () => {
  fileDatabase();
  const props = reactive({
    value: 5 as any,
    label: "表头",
    surface: "header" as const,
    onChange: (value: any) => {
      props.value = value;
    },
  });
  await mount(ExternalStyleImageControl, props);
  await upload([new File(["bytes"], "header.png", { type: "image/png" })]);
  expect(props.value.id).toMatch(/^file_/);
  expect(props.value).not.toHaveProperty("preview");
  expect(await (await fileRepository.readFile(copy(props.value))).text()).toBe(
    "bytes",
  );
  const saved = copy(props.value);
  await upload([new File(["svg"], "bad.svg", { type: "image/svg+xml" })]);
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "png",
  );
  expect(props.value).toEqual(saved);
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
    throw Error("quota");
  });
  await upload([new File(["other"], "new.png", { type: "image/png" })]);
  expect(props.value).toEqual(saved);
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "保留原有",
  );
  await click("删除表头图片");
  expect(props.value).toBeUndefined();
  expect(await (await fileRepository.readFile(saved)).text()).toBe("bytes");
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});
it("closing an uploading control cancels a late result, and missing stored images preserve fill controls", async () => {
  fileDatabase();
  let resolve!: (value: any) => void;
  const changed = vi.fn();
  vi.spyOn(fileRepository, "saveFiles").mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await mount(ExternalStyleImageControl, {
    value: 5,
    label: "表头",
    surface: "header",
    onChange: changed,
  });
  await upload(
    [new File(["bytes"], "header.png", { type: "image/png" })],
    false,
  );
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  cleanup.splice(0).forEach((fn) => fn());
  resolve([
    {
      id: "file_" + "a".repeat(36),
      name: "header.png",
      type: "image/png",
      size: 5,
    },
  ]);
  await settle();
  expect(changed).not.toHaveBeenCalled();
  const custom = customStyleFromTheme(5);
  custom.header.image = {
    id: "file_" + "b".repeat(36),
    name: "missing.png",
    size: 20,
    type: "image/png",
  };
  const host = await mount(ExternalFormFrame, {
    appearance: { theme: 5, custom },
    title: "仍可填写",
  });
  await settle();
  expect(host.querySelector('[role="status"]')!.textContent).toContain(
    "仍可继续填写",
  );
  expect(host.querySelector("h2")!.textContent).toBe("仍可填写");
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
    custom: customStyleFromTheme(4),
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
it("a delayed image read cannot replace a newer selection, and switching to color releases the loaded image", async () => {
  fileDatabase();
  let resolveOld!: (value: Blob) => void;
  const previous = new Promise<Blob>((resolve) => {
    resolveOld = resolve;
  });
  const current = new Blob(["current"], { type: "image/png" });
  vi.spyOn(fileRepository, "readFile").mockImplementation((value) =>
    value.name === "old.png" ? previous : Promise.resolve(current),
  );
  const appearance: ExternalFormStyle = {
    theme: 5,
    custom: customStyleFromTheme(5),
  };
  appearance.custom!.header.image = {
    id: "file_" + "a".repeat(36),
    name: "old.png",
    size: 3,
    type: "image/png",
  };
  const props = reactive({ appearance, title: "图片切换" });
  const host = await mount(ExternalFormFrame, props);
  props.appearance.custom!.header.image = {
    id: "file_" + "b".repeat(36),
    name: "new.png",
    size: 7,
    type: "image/png",
  };
  await settle();
  const selected = host.querySelector<HTMLImageElement>(
    ".external-form-banner img",
  )!.src;
  resolveOld(new Blob(["old"], { type: "image/png" }));
  await settle();
  expect(
    host.querySelector<HTMLImageElement>(".external-form-banner img")!.src,
  ).toBe(selected);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  props.appearance.custom!.header.type = "color";
  await nextTick();
  expect(host.querySelector(".external-form-banner img")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(selected);
  expect(props.appearance.custom!.header.image).toMatchObject({
    name: "new.png",
  });
});
function fixture() {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "name", label: "姓名", required: true }),
  ];
  return schema;
}
async function mount(component: any, props: any) {
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
function button(label: string) {
  return [
    ...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button, input[type="radio"]',
    ),
  ].find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  )!;
}
async function click(label: string) {
  button(label).focus();
  button(label).click();
  await nextTick();
  await nextTick();
}

it("the fixed template catalogue survives parsing and page projection; malformed styles are never silently dropped", () => {
  expect(externalThemes).toHaveLength(externalThemeCount);
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
it("template selection and device switches keep preview values, use shared close/focus and never submit records", async () => {
  const schema = reactive(fixture());
  await mount(FormExternalStyleSettings, {
    schema,
    title: "活动报名",
    formId: "qa",
  });
  button("表单外链样式设置").focus();
  await click("表单外链样式设置");
  const name = document.querySelector<HTMLInputElement>('[aria-label="姓名"]')!;
  name.value = "预览甲";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await click("主题4");
  expect(schema.settings.externalStyle).toEqual({ theme: 4 });
  expect(
    document
      .querySelector<HTMLElement>(".external-form")!
      .style.getPropertyValue("--external-background-image"),
  ).toContain("background-4.png");
  expect(document.querySelector(".external-form-head h2")!.textContent).toBe(
    "活动报名",
  );
  expect(
    document.querySelector<HTMLImageElement>(".external-form-banner img")!.src,
  ).toContain("banner-4.jpg");
  await click("手机外链预览");
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="姓名"]')!.value,
  ).toBe("预览甲");
  expect(document.querySelector(".runtime-fields.is-mobile")).not.toBeNull();
  await click("主题2");
  await click("提交");
  expect(document.querySelector(".runtime-footer")!.textContent).toContain(
    "预览数据未提交",
  );
  expect(useWorkspaceStore().data.entries).toHaveLength(0);
  expect(schema.fields[0]!.defaultValue).toBe("");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await nextTick();
  await nextTick();
  expect(document.querySelector(".external-style-dialog")).toBeNull();
  expect(document.activeElement).toBe(button("表单外链样式设置"));
  expect(parseSchema(copy(schema)).settings.externalStyle).toEqual({
    theme: 2,
  });
});
it("old forms remain unthemed until explicitly configured, without adding a header to normal record or designer previews", async () => {
  const props = reactive({
    title: "旧表单",
    appearance: undefined as { theme: number } | undefined,
  });
  const host = await mount(ExternalFormFrame, props);
  expect(host.querySelector(".external-form-head")).toBeNull();
  expect(host.querySelector(".fill-page-sheet")).not.toBeNull();
  props.appearance = { theme: 1 };
  await nextTick();
  expect(host.querySelector(".external-form-head h2")!.textContent).toBe(
    "旧表单",
  );
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
