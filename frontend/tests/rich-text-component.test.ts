// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import RichTextEditor from "../src/components/rich-text/RichTextEditor.vue";
import type { RichTextImageStorage } from "../src/components/rich-text/types";
import { sanitizeRichText } from "../src/domain/richText";

let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await nextTick();
};
const button = (label: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  )!;
function selectEnd(editor: HTMLElement) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}
async function mount(values = ["<p>原文</p>"], storage?: RichTextImageStorage) {
  // Standalone use: no Pinia, workspace, router or browser database.
  vi.stubGlobal("indexedDB", undefined);
  const items = reactive(
    values.map((value, i) => ({
      value,
      readonly: false,
      label: `编辑器${i + 1}`,
    })),
  );
  const changes = vi.fn();
  const exec = vi.fn((action: string, _ui?: boolean, value?: string) => {
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (range && action === "insertHTML") {
      range.deleteContents();
      const content = range.createContextualFragment(value || "");
      range.insertNode(content);
    }
    if (range && action === "delete") range.deleteContents();
    return true;
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: exec,
  });
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    render: () =>
      h(
        "div",
        items.map((item, index) =>
          h(RichTextEditor, {
            key: index,
            modelValue: item.value,
            readonly: item.readonly,
            label: item.label,
            imageStorage: storage,
            "onUpdate:modelValue": (value: string) => {
              item.value = value;
              changes(index, value);
            },
          }),
        ),
      ),
  });
  app.mount("#app");
  await settle();
  return {
    items,
    changes,
    exec,
    editors: [...document.querySelectorAll<HTMLElement>(".rich-editable")],
  };
}
function objectURLs() {
  const created = vi.fn(() => "blob:standalone-image");
  const revoked = vi.fn();
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = created;
      static revokeObjectURL = revoked;
    },
  );
  return { created, revoked };
}
async function chooseImage(editor: HTMLElement) {
  selectEnd(editor);
  button("插入图片", editor.closest(".rich-text-editor")!).click();
  await settle();
  const file = new NodeFile([new Uint8Array([1, 2, 3])], "example.png", {
    type: "image/png",
  });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  button("确定").click();
  await settle();
  return file;
}

it("keeps two standalone editors, selections and dialog labels independent", async () => {
  const f = await mount(["<p>甲</p>", "<p>乙</p>"]);
  const [a, b] = f.editors as [HTMLElement, HTMLElement];
  selectEnd(a);
  a.querySelector("p")!.append("的内容");
  a.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(f.items.map((item) => item.value)).toEqual([
    "<p>甲的内容</p>",
    "<p>乙</p>",
  ]);
  expect(f.changes).toHaveBeenCalledTimes(1);
  const ids: string[] = [];
  for (const editor of [a, b]) {
    selectEnd(editor);
    button("插入链接", editor.closest(".rich-text-editor")!).click();
    await settle();
    const input =
      document.querySelector<HTMLInputElement>('input[id$="-link"]')!;
    ids.push(input.id);
    expect(input.labels![0]!.textContent).toBe("链接地址");
    button("取消").click();
    await settle();
  }
  expect(new Set(ids).size).toBe(2);
  expect(b.textContent).toBe("乙");
});

it("preserves local input echoes but applies an explicit external replacement while focused", async () => {
  const f = await mount();
  const editor = f.editors[0]!;
  selectEnd(editor);
  const original = editor.firstChild;
  editor.querySelector("p")!.append("补充");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(editor.firstChild).toBe(original);
  expect(f.items[0]!.value).toBe("<p>原文补充</p>");
  f.items[0]!.value = "<h2>切换到其他内容</h2>";
  await settle();
  expect(editor.innerHTML).toBe("<h2>切换到其他内容</h2>");
  expect(f.changes).toHaveBeenCalledTimes(1);
});

it("uses an injected storage adapter, preserves failed uploads for retry and serializes only stable references", async () => {
  const urls = objectURLs();
  const upload = vi
    .fn()
    .mockRejectedValueOnce(Error("上传失败，请重试"))
    .mockResolvedValue([{ id: "asset_001", alt: "example.png" }]);
  const resolve = vi
    .fn()
    .mockResolvedValue(new NodeBlob(["image"], { type: "image/png" }));
  const f = await mount(undefined, { upload, resolve });
  await chooseImage(f.editors[0]!);
  expect(document.body.textContent).toContain("上传失败，请重试");
  expect(document.body.textContent).toContain("example.png");
  expect(f.changes).not.toHaveBeenCalled();
  button("确定").click();
  await vi.waitFor(() =>
    expect(f.editors[0]!.querySelector("img")?.src).toBe(
      "blob:standalone-image",
    ),
  );
  expect(upload).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenCalledWith("asset_001");
  expect(f.items[0]!.value).toContain('data-file-id="asset_001"');
  expect(f.items[0]!.value).not.toContain("blob:");
  app!.unmount();
  app = undefined;
  expect(urls.revoked).toHaveBeenCalledWith("blob:standalone-image");
});

it.each(["replacement", "readonly", "unmount"])(
  "ignores a pending upload after %s",
  async (change) => {
    let finish!: (value: { id: string }[]) => void;
    const upload = vi.fn(
      () =>
        new Promise<{ id: string }[]>((resolve) => {
          finish = resolve;
        }),
    );
    const f = await mount(undefined, { upload });
    await chooseImage(f.editors[0]!);
    expect(document.body.textContent).toContain("正在保存图片");
    if (change === "replacement") f.items[0]!.value = "<p>新内容</p>";
    if (change === "readonly") f.items[0]!.readonly = true;
    if (change === "unmount") {
      app!.unmount();
      app = undefined;
    }
    await settle();
    finish([{ id: "late_image" }]);
    await settle();
    expect(f.changes).not.toHaveBeenCalled();
    expect(f.items[0]!.value).toBe(
      change === "replacement" ? "<p>新内容</p>" : "<p>原文</p>",
    );
  },
);

it("retries image loading without modifying content and does not allocate URLs after unmount", async () => {
  const urls = objectURLs();
  let finish!: (blob: Blob) => void;
  const resolve = vi
    .fn()
    .mockRejectedValueOnce(Error("图片加载失败"))
    .mockImplementation(
      () =>
        new Promise<Blob>((accept) => {
          finish = accept;
        }),
    );
  const f = await mount(['<img data-file-id="retained_image" alt="图">'], {
    upload: vi.fn(),
    resolve,
  });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("图片加载失败"),
  );
  button("重新加载图片").click();
  await settle();
  app!.unmount();
  app = undefined;
  finish(new NodeBlob(["image"], { type: "image/png" }) as Blob);
  await settle();
  expect(urls.created).not.toHaveBeenCalled();
  expect(f.changes).not.toHaveBeenCalled();
});

it("aligns, previews and removes only the selected image while retaining shared link contents", async () => {
  const f = await mount([
    '<a href="https://example.com"><img src="https://example.com/a.png"><b>说明<img src="https://example.com/b.png"></b></a>',
  ]);
  const editor = f.editors[0]!;
  editor.querySelectorAll("img")[1]!.click();
  await settle();
  button("图片居中").click();
  await settle();
  const image = editor.querySelectorAll<HTMLImageElement>("img")[1]!;
  expect(image.style.display).toBe("block");
  expect(image.style.marginLeft).toBe("auto");
  expect(image.style.marginRight).toBe("auto");
  expect(editor.querySelector("img")!.style.display).toBe("");
  expect(sanitizeRichText(f.items[0]!.value)).toBe(f.items[0]!.value);
  image.click();
  await settle();
  button("放大查看图片").click();
  await settle();
  expect(
    document.querySelector(".rich-image-preview")!.getAttribute("src"),
  ).toBe("https://example.com/b.png");
  const before = f.items[0]!.value;
  button("关闭").click();
  await settle();
  expect(f.items[0]!.value).toBe(before);
  image.click();
  await settle();
  button("删除图片").click();
  await settle();
  expect(editor.querySelectorAll("img")).toHaveLength(1);
  expect(editor.querySelector("b")!.textContent).toBe("说明");
  expect(editor.querySelector("a")!.href).toBe("https://example.com/");
});

it("allows readonly image viewing without exposing editing tools or emitting changes", async () => {
  const f = await mount(['<img src="https://example.com/a.png">']);
  f.items[0]!.readonly = true;
  await settle();
  f.editors[0]!.querySelector("img")!.click();
  await settle();
  expect(document.querySelector('[aria-label="图片设置"]')).toBeNull();
  expect(document.querySelector(".rich-toolbar")).toBeNull();
  expect(document.querySelector(".rich-image-preview")).not.toBeNull();
  expect(f.editors[0]!.getAttribute("aria-readonly")).toBe("true");
  expect(f.changes).not.toHaveBeenCalled();
});
