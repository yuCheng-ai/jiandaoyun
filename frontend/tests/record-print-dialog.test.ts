// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import RecordPrintDialog from "../src/features/forms/components/RecordPrintDialog.vue";
import { createField, emptySchema } from "../src/domain/form";
import {
  newPrintTemplate,
  type PrintTemplate,
} from "../src/domain/presentation";
import type { FormEntry } from "../src/domain/workspace";

const generate = vi.hoisted(() => vi.fn());
vi.mock("../src/features/forms/exportRecordPdf", () => ({
  createRecordPdfBlob: generate,
}));
vi.mock("../src/stores/workspace", () => ({
  useWorkspaceStore: () => ({ writePending: false }),
}));
vi.mock("../src/composables/useRuntimeData", async () => {
  const { computed } = await import("vue");
  const { seedWorkspace } = await import("../src/domain/workspace");
  return { useRuntimeData: () => computed(() => seedWorkspace()) };
});
vi.mock("../src/features/forms/components/PrintDocument.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/components/shared/EditorDraftNotice.vue", () => ({
  default: { render: () => null },
}));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  generate
    .mockReset()
    .mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
  URL.createObjectURL = vi.fn(() => "blob:pdf-test");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
async function mount(naming?: PrintTemplate["fileName"] | false) {
  const schema = emptySchema();
  schema.fields = [createField("text", { id: "name", label: "名称" })];
  const template = {
    ...newPrintTemplate(schema, "正式单据"),
    id: "published",
    paper: "A5" as const,
  };
  if (naming === false) delete template.fileName;
  else if (naming) template.fileName = naming;
  const entry: FormEntry = {
    id: "entry-1",
    formId: "form-1",
    definitionVersion: 2,
    createdAt: "2026-10-08",
    status: "submitted",
    values: { name: "实际内容" },
    history: [],
  };
  const open = ref(true);
  const app = createApp({
    render: () =>
      h(RecordPrintDialog, {
        open: open.value,
        schema,
        title: "表单",
        entry,
        templates: [{ ...template, id: "archived", archived: true }, template],
        onClose: () => {
          open.value = false;
        },
      }),
  });
  app.mount(document.querySelector("#app")!);
  cleanups.push(() => app.unmount());
  await nextTick();
  return { open };
}
const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  )!;
describe("record PDF delivery interaction", () => {
  it("selects the first published active template on initial open and exposes a retry download link", async () => {
    await mount();
    expect(document.querySelector("select")!.value).toBe("published");
    button("下载 PDF").click();
    await vi.waitFor(() =>
      expect(document.querySelector("a[download]")).not.toBeNull(),
    );
    expect(generate.mock.calls[0]![0].pageSize).toBe("A5");
    expect(JSON.stringify(generate.mock.calls[0]![0].content)).toContain(
      "实际内容",
    );
    expect(
      document.querySelector("a[download]")!.getAttribute("download"),
    ).toMatch(/^表单_\d{8}_\d{6}\.pdf$/);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(button("下载 PDF").disabled).toBe(false);
  });
  it.each([
    [{ mode: "title", value: "" }, "实际内容.pdf"],
    [{ mode: "custom", value: "合同-{{name}}" }, "合同-实际内容.pdf"],
    [false, "正式单据-entry-1.pdf"],
  ] as const)(
    "downloads with the selected published naming configuration %j",
    async (naming, expected) => {
      await mount(naming);
      button("下载 PDF").click();
      await vi.waitFor(() =>
        expect(document.querySelector("a[download]")).not.toBeNull(),
      );
      expect(
        document.querySelector("a[download]")!.getAttribute("download"),
      ).toBe(expected);
      expect(document.querySelector("a[download]")!.textContent).toContain(
        expected,
      );
    },
  );
  it("keeps the preview open and allows retry after generation fails", async () => {
    generate.mockRejectedValueOnce(
      Error("中文字体加载失败，请检查网络后重试。"),
    );
    await mount();
    button("下载 PDF").click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "中文字体加载失败",
      ),
    );
    expect(button("下载 PDF").disabled).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    button("下载 PDF").click();
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    expect(document.querySelector("a[download]")).not.toBeNull();
  });
  it("does not download a late result after the user closes the preview", async () => {
    let finish!: (blob: Blob) => void;
    generate.mockReturnValue(
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
    );
    const state = await mount();
    button("下载 PDF").click();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    button("关闭预览").click();
    await nextTick();
    expect(state.open.value).toBe(false);
    finish(new Blob(["pdf"]));
    await nextTick();
    await nextTick();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
  });
});
