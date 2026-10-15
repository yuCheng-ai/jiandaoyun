import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, ref } from "vue";
import * as fileRepository from "../src/repositories/fileRepository";
import { createMemoryHistory, createRouter } from "vue-router";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
import { createPinia } from "pinia";
import {
  fileValueIssue,
  fileSettingsErrors,
  type FileValue,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import {
  buildRecordBlocks,
  defaultDetailSettings,
} from "../src/domain/presentation";

import FileFieldControl from "../src/features/forms/components/FileFieldControl.vue";
import FileFieldInspector from "../src/features/forms/components/FileFieldInspector.vue";
import RecordBody from "../src/features/forms/components/RecordBody.vue";

let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 12; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (let i = 0; i < 5; i++) await nextTick();
};
const el = <T extends HTMLElement = HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)!;
const file = (name = "invoice.pdf", size = 4, type = "application/pdf") => ({
  name,
  size,
  type,
});
async function mount(render: Parameters<typeof createApp>[0]) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(render);
  app.use(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  app.use(router);
  await router.push("/");
  app.mount("#app");
  await settle();
}
async function upload(files: unknown[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}
afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

it("format/count/size checks handle the exact boundary, case, single file and historical MIME filters", () => {
  const field = createField("file", { accept: ".pdf,.xlsx", maxFileSize: 2 });
  expect(
    fileValueIssue(field, [file("INVOICE.PDF", 2 * 1024 * 1024)]),
  ).toBeUndefined();
  expect(
    fileValueIssue(field, [file("INVOICE.PDF", 2 * 1024 * 1024 + 1)]),
  ).toContain("超过");
  expect(fileValueIssue(field, [file("invoice.pdf.exe")])).toContain("格式");
  expect(
    fileValueIssue(
      field,
      Array.from({ length: 11 }, () => file()),
    ),
  ).toContain("10");
  expect(
    fileValueIssue({ ...field, multiple: false }, [file(), file()]),
  ).toContain("单个");
  expect(
    fileValueIssue({ ...field, accept: "application/pdf" }, [file()]),
  ).toBeUndefined();
  expect(
    fileValueIssue({ ...field, limitFileTypes: false }, [file("notes.txt")]),
  ).toBeUndefined();
  expect(
    fileValueIssue(field, [
      { ...file(), id: "same" },
      { ...file(), id: "same" },
    ]),
  ).toContain("重复");
  expect(fileValueIssue(field, [{ name: "bad" }])).toContain("无效");
});
it("new images use source formats and historical WebP stays valid without accepting SVG", () => {
  const image = createField("image");
  expect(image.accept).toBe(".jpg,.jpeg,.png,.gif");
  expect(
    fileValueIssue(image, [file("a.png", 5, "image/png")]),
  ).toBeUndefined();
  expect(fileValueIssue(image, [file("a.webp", 5, "image/webp")])).toContain(
    "格式",
  );
  expect(
    fileValueIssue({ ...image, accept: "image/*" }, [
      file("a.webp", 5, "image/webp"),
    ]),
  ).toBeUndefined();
  expect(
    fileValueIssue({ ...image, accept: "image/*" }, [
      file("a.svg", 5, "image/svg+xml"),
    ]),
  ).toBeTruthy();
});
it("configuration survives schema parsing and validation covers visible subform cells", () => {
  const schema = emptySchema();
  const field = createField("file", {
    id: "doc",
    limitFileTypes: true,
    accept: ".pdf",
    maxFileSize: 1,
  });
  const image = createField("image", { uploadStyle: "list" });
  schema.fields = [
    field,
    image,
    createField("subform", {
      id: "rows",
      children: [createField("file", { id: "cell", multiple: false })],
    }),
  ];
  expect(parseSchema(schema).fields).toEqual(schema.fields);
  expect(
    fileSettingsErrors({ ...field, accept: ".toolongformat" }),
  ).toHaveLength(1);
  expect(() =>
    parseSchema({ ...schema, fields: [{ ...field, maxFileSize: 0 }] }),
  ).toThrow("上限");
  expect(
    validateValues(schema, {
      doc: [file("a.pdf", 1024 * 1024 + 1)],
      rows: [{ cell: [file(), file()] }],
    }).map((e) => e.path),
  ).toEqual(["doc", "rows.0.cell"]);
  field.visible = false;
  expect(validateValues(schema, { doc: [file("a.exe")] })).toEqual([]);
  const old = createField("file", { accept: "image/*" });
  expect(parseSchema({ ...schema, fields: [old] }).fields[0]).toEqual(old);
  const unvalidatedLegacy = { ...old, accept: ".pdf .docx" };
  expect(
    parseSchema({ ...schema, fields: [unvalidatedLegacy] }).fields[0],
  ).toEqual(unvalidatedLegacy);
});
it("invalid single replacement preserves the original file and shows the reason", async () => {
  const field = createField("file", { multiple: false, accept: ".pdf" });
  const value = ref<FileValue[]>([file()]);
  await mount({
    render: () =>
      h(FileFieldControl, {
        field,
        modelValue: value.value,
        "onUpdate:modelValue": (v) => (value.value = v),
      }),
  });
  await upload([
    new File(["x"], "wrong.exe", { type: "application/octet-stream" }),
  ]);
  expect(value.value).toEqual([file()]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "格式",
  );
  await upload([
    new File(["x"], "a.pdf", { type: "application/pdf" }),
    new File(["x"], "b.pdf", { type: "application/pdf" }),
  ]);
  expect(value.value).toHaveLength(1);
});
it("storage errors preserve existing values and leave upload available for retry", async () => {
  vi.spyOn(fileRepository, "saveFiles").mockRejectedValueOnce(
    new Error("文件保存失败，请重试"),
  );
  const field = createField("file");
  const value = ref<FileValue[]>([file()]);
  await mount({
    render: () =>
      h(FileFieldControl, {
        field,
        modelValue: value.value,
        "onUpdate:modelValue": (v) => (value.value = v),
      }),
  });
  await upload([new File(["x"], "a.txt")]);
  expect(value.value).toHaveLength(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "保存",
  );
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
});
it("saved files can be reordered/removed without changing identities; readonly files remain viewable", async () => {
  vi.spyOn(fileRepository, "saveFiles").mockImplementation(async (files) =>
    files.map((f, i) => ({
      id: `saved-${f.name}-${i}`,
      name: f.name,
      size: f.size,
      type: f.type,
    })),
  );
  vi.spyOn(fileRepository, "readFile").mockResolvedValue(
    new Blob(["content"], { type: "text/plain" }),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:test");
      static revokeObjectURL = vi.fn();
    },
  );
  const field = createField("file");
  const value = ref<FileValue[]>([]);
  const disabled = ref(false);
  await mount({
    render: () =>
      h(FileFieldControl, {
        field,
        modelValue: value.value,
        disabled: disabled.value,
        "onUpdate:modelValue": (v) => (value.value = v),
      }),
  });
  await upload([
    new File(["a"], "a.txt", { type: "text/plain" }),
    new File(["b"], "b.txt", { type: "text/plain" }),
  ]);
  await vi.waitFor(() => expect(value.value).toHaveLength(2));
  const ids = value.value.map((v) => v.id);
  el("前移 b.txt").click();
  await settle();
  expect(value.value.map((v) => v.id)).toEqual(ids.reverse());
  el("移除 a.txt").click();
  await settle();
  expect(value.value[0]!.name).toBe("b.txt");
  disabled.value = true;
  await settle();
  expect(el("移除 b.txt")).toBeNull();
  el("查看 b.txt").click();
  await vi.waitFor(() =>
    expect(document.querySelector("dialog")?.textContent).toContain("可下载"),
  );
  expect(document.querySelector("dialog")?.textContent).toContain("下载");
});
it("formats are optional, Enter adds normalized extensions and unchecking retains configuration", async () => {
  const field = reactive(createField("file"));
  await mount({
    render: () =>
      h(FileFieldInspector, {
        field,
        onUpdate: (patch) => Object.assign(field, patch),
      }),
  });
  const format = [...document.querySelectorAll("label")]
    .find((l) => l.textContent?.includes("设置允许上传"))!
    .querySelector<HTMLInputElement>("input")!;
  format.click();
  await settle();
  const input = el<HTMLInputElement>("允许上传的文件格式");
  input.value = "PDF,png";
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await settle();
  expect(field.accept).toBe(".pdf,.png");
  format.click();
  await settle();
  expect(field.accept).toBe(".pdf,.png");
  expect(field.limitFileTypes).toBe(false);
});
it("record details expose only visible main and subform attachments", async () => {
  const schema = emptySchema();
  schema.fields = [
    createField("file", { id: "hidden", visible: false }),
    createField("file", { id: "shown" }),
    createField("subform", {
      id: "rows",
      children: [
        createField("file", { id: "cell" }),
        createField("image", { id: "secret", visible: false }),
      ],
    }),
  ];
  const values = {
    hidden: [file("secret.pdf")],
    shown: [file("public.pdf")],
    rows: [
      { cell: [file("row.pdf")], secret: [file("secret.png", 5, "image/png")] },
    ],
  };
  const data = seedWorkspace();
  const blocks = buildRecordBlocks(
    schema,
    values,
    defaultDetailSettings(),
    data,
  );
  expect(blocks.map((b) => b.id)).toEqual(["shown", "rows"]);
  expect(blocks[1]!.rowFiles).toEqual([[[file("row.pdf")]]]);
  await mount({
    render: () =>
      h(RecordBody, {
        schema,
        values,
        settings: defaultDetailSettings(),
        interactive: true,
      }),
  });
  expect(el("查看 public.pdf")).toBeTruthy();
  expect(el("查看 row.pdf")).toBeTruthy();
  expect(document.body.textContent).not.toContain("secret");
});

it("an upload finishing after readonly or unmount never writes into the old editor", async () => {
  let finish!: (value: FileValue[]) => void;
  vi.spyOn(fileRepository, "saveFiles").mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const field = createField("file");
  const disabled = ref(false);
  const changed = vi.fn();
  await mount({
    render: () =>
      h(FileFieldControl, {
        field,
        disabled: disabled.value,
        "onUpdate:modelValue": changed,
      }),
  });
  await upload([new File(["a"], "a.txt")]);
  expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  disabled.value = true;
  await settle();
  finish([{ ...file("a.txt"), id: "saved" }]);
  await settle();
  expect(changed).not.toHaveBeenCalled();
  disabled.value = false;
  await settle();
  await upload([new File(["b"], "b.txt")]);
  app!.unmount();
  app = undefined;
  finish([{ ...file("b.txt"), id: "other" }]);
  await settle();
  expect(changed).not.toHaveBeenCalled();
});
it("the runtime waits for actual file storage before submitting and does not silently omit the upload", async () => {
  let finish!: (value: FileValue[]) => void;
  vi.spyOn(fileRepository, "saveFiles").mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const schema = emptySchema();
  schema.fields = [
    createField("file", { id: "document" }),
    createField("text", { id: "note", label: "备注" }),
  ];

  await mount({
    render: () =>
      h(FormRuntime, {
        schema,
        formId: "qa",
      }),
  });
  await upload([new File(["a"], "a.txt")]);
  const submit = document.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  expect(submit.disabled).toBe(true);
  expect(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("保存草稿"),
    )?.disabled,
  ).toBe(true);
  expect(submit.textContent).toContain("上传");
  const note = el<HTMLInputElement>("备注");
  note.value = "上传期间补充";
  note.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(submit.disabled).toBe(true);
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  finish([{ ...file("a.txt"), id: "saved" }]);
  await settle();
  expect(submit.disabled).toBe(false);
  submit.click();
  await settle();
});

it("a real file value change still invalidates an older pending upload", async () => {
  let finish!: (value: FileValue[]) => void;
  vi.spyOn(fileRepository, "saveFiles").mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const value = ref<FileValue[]>([]),
    changed = vi.fn();
  const field = createField("file");
  await mount({
    render: () =>
      h(FileFieldControl, {
        field,
        modelValue: value.value,
        "onUpdate:modelValue": changed,
      }),
  });
  await upload([new File(["a"], "a.txt")]);
  value.value = [{ ...file("new.txt"), id: "replacement" }];
  await settle();
  finish([{ ...file("a.txt"), id: "old-upload" }]);
  await settle();
  expect(changed).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("new.txt");
});
