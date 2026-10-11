// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick, reactive, h } from "vue";
import { createPinia } from "pinia";
import {
  richTextLink,
  sanitizeRichText,
  richTextPlainText,
  richImageFilesIssue,
  richImageFilesHtml,
} from "../src/domain/richText";
import {
  createField,
  defaultValues,
  emptySchema,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import RichTextEditor from "../src/features/forms/components/RichTextEditor.vue";
import FieldInspector from "../src/features/forms/components/FieldInspector.vue";
import RecordBody from "../src/features/forms/components/RecordBody.vue";
import { defaultDetailSettings } from "../src/domain/presentation";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { readFile } from "../src/repositories/fileRepository";

let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await nextTick();
};
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  )!;
function html(value: string) {
  const root = document.createElement("div");
  root.innerHTML = value;
  return root;
}
async function mount(
  readonly = false,
  value = "<p>业务说明</p>",
  variant: "description" | "field" = "description",
) {
  const state = reactive({ value, readonly });
  const update = vi.fn((value) => {
    state.value = value;
  });
  document.body.innerHTML = '<div id="mount"></div>';
  // Browser editing is exercised separately; the unit test inspects the selection
  // delivered to the native command and the sanitized result returned to the form.
  const exec = vi.fn((action: string, _ui?: boolean, value?: string) => {
    const editor = document.querySelector<HTMLElement>(".rich-editable")!;
    if (action === "insertHTML") {
      const selection = document.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
      if (range && editor.contains(range.commonAncestorContainer)) {
        const content = range.createContextualFragment(value || "");
        range.deleteContents();
        range.insertNode(content);
      } else editor.innerHTML = value || "";
    }
    if (action === "createLink") {
      const range = document.getSelection()!.getRangeAt(0),
        anchor = document.createElement("a");
      anchor.href = value!;
      anchor.appendChild(range.extractContents());
      range.insertNode(anchor);
    }
    return true;
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: exec,
  });
  app = createApp({
    render: () =>
      h(RichTextEditor, {
        modelValue: state.value,
        readonly: state.readonly,
        variant,
        "onUpdate:modelValue": update,
      }),
  });
  app.mount("#mount");
  await settle();
  return {
    update,
    state,
    exec,
    editor: document.querySelector<HTMLElement>(".rich-editable")!,
  };
}

it("keeps supported formatting, normalizes browser font tags and survives a schema round trip", () => {
  const source =
    '<p style="text-align:center"><font color="#d03030" size="5"><b>标题</b></font><br><i style="text-decoration-line:underline">说明</i></p>';
  const sanitized = sanitizeRichText(source),
    rendered = html(sanitized);
  expect(rendered.querySelector("p")!.style.textAlign).toBe("center");
  expect(rendered.querySelector("span")!.style.fontSize).toBe("24px");
  expect(rendered.querySelector("span")!.style.color).toBe("rgb(208, 48, 48)");
  expect(rendered.querySelector("b")!.textContent).toBe("标题");
  expect(rendered.querySelector("i")!.style.textDecoration).toBe("underline");
  expect(sanitizeRichText(sanitized)).toBe(sanitized);
  const schema = emptySchema();
  schema.fields = [createField("text", { description: sanitized })];
  expect(
    parseSchema(JSON.parse(JSON.stringify(schema))).fields[0]!.description,
  ).toBe(sanitized);
});
it("retains links and embedded images while removing scripts, event handlers and unrelated CSS", () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const rendered = html(
    sanitizeRichText(
      `<p style="position:fixed;background:url(https://example.com);color:red"><a href="https://example.com/guide" onclick="alert(1)">说明</a><img src="${image}" onerror="alert(1)" alt="示意图"><script>alert(1)</script></p>`,
    ),
  );
  expect(rendered.querySelector("p")!.style.color).toBe("red");
  expect(rendered.querySelector("p")!.style.position).toBe("");
  expect(rendered.querySelector("p")!.style.background).toBe("");
  expect(rendered.querySelector("a")!.getAttribute("rel")).toBe(
    "noopener noreferrer",
  );
  expect(rendered.querySelector("img")!.getAttribute("src")).toBe(image);
  expect(rendered.querySelector("[onclick],[onerror],script")).toBeNull();
  expect(
    html(
      sanitizeRichText(
        '<a href="javascript:alert(1)">危险地址</a><img src="data:image/svg+xml;base64,PHN2Zz4=">',
      ),
    ).querySelector("[href],img"),
  ).toBeNull();
  expect(richTextLink("javascript:alert(1)")).toBeUndefined();
  expect(richTextLink(" /help ")).toBe("/help");
});
it("a link dialog preserves selected text, rejects an invalid address and returns sanitized markup", async () => {
  const f = await mount();
  const text = f.editor.querySelector("p")!.firstChild!;
  f.editor.focus();
  const range = document.createRange();
  range.selectNodeContents(text);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  button("插入链接").click();
  await settle();
  const input = document.querySelector<HTMLInputElement>('[id$="-link"]')!;
  input.focus();
  // Returning focus from the dialog can move the browser caret. The original
  // selected range must survive until the native link command uses it.
  const focus = f.editor.focus.bind(f.editor);
  vi.spyOn(f.editor, "focus").mockImplementation((options) => {
    const caret = document.createRange();
    caret.selectNodeContents(f.editor);
    caret.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(caret);
    focus(options);
    f.editor.dispatchEvent(new Event("focus"));
  });
  input.value = "javascript:alert(1)";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  button("确定").click();
  await settle();
  expect(document.querySelector("[role='status']")!.textContent).toContain(
    "有效的链接地址",
  );
  expect(f.exec).not.toHaveBeenCalled();
  input.value = "https://example.com/guide";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  button("确定").click();
  await settle();
  expect(f.exec).toHaveBeenCalledWith(
    "insertHTML",
    false,
    expect.stringContaining('href="https://example.com/guide"'),
  );
  expect(
    html(f.update.mock.calls.at(-1)![0]).querySelector("a")!.textContent,
  ).toBe("业务说明");
});
it("readonly content has no editing tools and emits no changes on blur", async () => {
  const f = await mount(true);
  expect(document.querySelector(".rich-toolbar")).toBeNull();
  expect(f.editor.getAttribute("contenteditable")).toBe("false");
  f.editor.dispatchEvent(new Event("blur"));
  expect(f.update).not.toHaveBeenCalled();
});
it("custom text color restores the original selected range and closes both pickers when editing focus returns", async () => {
  const f = await mount();
  const visible = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue([{}] as unknown as DOMRectList);
  f.editor.focus();
  const range = document.createRange();
  range.selectNodeContents(f.editor.querySelector("p")!);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  button("文字颜色").dispatchEvent(new Event("pointerdown", { bubbles: true }));
  button("文字颜色").click();
  await settle();
  expect(document.querySelectorAll(".option-color-grid button")).toHaveLength(
    32,
  );
  expect(
    document
      .querySelector(".option-color-grid button")!
      .getAttribute("aria-label"),
  ).toBe("颜色 #8d3030");
  button("文字自定义颜色").click();
  await settle();
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="文字 HEX"]',
  )!;
  input.focus();
  document.getSelection()!.removeAllRanges();
  let selected = "";
  f.exec.mockImplementation((action) => {
    if (action === "foreColor") selected = document.getSelection()!.toString();
    return true;
  });
  input.value = "#123456";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(f.exec).not.toHaveBeenCalledWith("foreColor", false, "#123456");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  expect(f.exec).toHaveBeenCalledWith("foreColor", false, "#123456");
  expect(selected).toBe("业务说明");
  expect(document.activeElement).toBe(f.editor);
  expect(
    document.querySelector(".custom-color-panel,.option-color-panel"),
  ).toBeNull();
  visible.mockRestore();
});
it("image widths survive sanitizing and schema round trips without retaining unrelated CSS", () => {
  for (const width of ["25%", "50%", "75%", "100%", "180px"]) {
    const content = sanitizeRichText(
      `<img src="https://example.com/p.png" style="width:${width};height:10px;position:fixed" onerror="alert(1)">`,
    );
    const image = html(content).querySelector("img")!;
    expect(image.style.width).toBe(width);
    expect(image.style.height).toBe("");
    expect(image.style.position).toBe("");
    expect(image.hasAttribute("onerror")).toBe(false);
    expect(sanitizeRichText(content)).toBe(content);
    const schema = emptySchema();
    schema.fields = [createField("text", { description: content })];
    expect(
      parseSchema(JSON.parse(JSON.stringify(schema))).fields[0]!.description,
    ).toBe(content);
  }
  expect(
    html(
      sanitizeRichText('<img src="https://example.com/p.png" width="120">'),
    ).querySelector("img")!.style.width,
  ).toBe("120px");
  expect(
    html(
      sanitizeRichText(
        '<img src="https://example.com/p.png" style="width:calc(100% + 20px)">',
      ),
    ).querySelector("img")!.style.width,
  ).toBe("");
});

it("image sizing and links edit only the selected image, preserve surrounding content and cancel without mutation", async () => {
  const f = await mount(
    false,
    '<p>前文</p><img src="https://example.com/p.png" alt="示意图"><p>后文</p>',
  );
  const selectImage = async () => {
    f.editor.querySelector("img")!.click();
    await settle();
  };
  await selectImage();
  expect(button("取消图片链接").disabled).toBe(true);
  await selectImage();
  button("图片宽度1/2").click();
  await settle();
  expect(f.editor.querySelector("img")!.style.width).toBe("50%");
  expect(f.editor.textContent).toBe("前文后文");
  await selectImage();
  button("图片链接").click();
  await settle();
  const before = f.editor.innerHTML;
  const address = document.querySelector<HTMLInputElement>('[id$="-link"]')!;
  address.value = "https://example.com/not-applied";
  address.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  button("取消").click();
  await settle();
  expect(f.editor.innerHTML).toBe(before);
  button("图片链接").click();
  await settle();
  const enter = async (value: string) => {
    const el = document.querySelector<HTMLInputElement>('[id$="-link"]')!;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    button("确定").click();
    await settle();
  };
  await enter("javascript:alert(1)");
  expect(f.editor.innerHTML).toBe(before);
  expect(document.querySelector("[role='status']")!.textContent).toContain(
    "有效的链接",
  );
  const newWindow = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  expect(newWindow.checked).toBe(true);
  newWindow.click();
  await settle();
  await enter("https://example.com/guide");
  expect(f.editor.querySelector("a img")!.getAttribute("src")).toBe(
    "https://example.com/p.png",
  );
  expect(f.editor.querySelector("a")!.getAttribute("href")).toBe(
    "https://example.com/guide",
  );
  expect(f.editor.querySelector("img")!.style.width).toBe("50%");
  expect(f.editor.querySelector("a")!.target).toBe("_self");
  await selectImage();
  button("图片宽度3/4").click();
  await settle();
  expect(f.editor.querySelector("a")!.getAttribute("href")).toBe(
    "https://example.com/guide",
  );
  expect(f.editor.querySelector("img")!.style.width).toBe("75%");
  expect(f.editor.querySelector("a")!.target).toBe("_self");
  await selectImage();
  button("取消图片链接").click();
  await settle();
  expect(f.editor.querySelector("a")).toBeNull();
  expect(f.editor.querySelector("img")!.style.width).toBe("75%");
  expect(f.editor.textContent).toBe("前文后文");
  await selectImage();
  f.editor.querySelector("p")!.click();
  await settle();
  expect(
    document.querySelector('[role="toolbar"][aria-label="图片设置"]'),
  ).toBeNull();
});

it("resizing a nested linked image preserves the other images and text in its link", async () => {
  const f = await mount(
    false,
    '<a href="https://example.com/guide"><img src="https://example.com/first.png" style="width:25%"><b>图例<img src="https://example.com/second.png"></b></a>',
  );
  f.editor.querySelectorAll("img")[1]!.click();
  await settle();
  button("图片宽度3/4").click();
  await settle();
  expect(
    Array.from(f.editor.querySelectorAll("img")).map(
      (image) => image.style.width,
    ),
  ).toEqual(["25%", "75%"]);
  expect(f.editor.querySelector("b")!.textContent).toBe("图例");
  expect(f.editor.querySelector("a")!.href).toBe("https://example.com/guide");
});

it("readonly rich text images cannot open editing controls", async () => {
  const f = await mount(
    true,
    '<img src="https://example.com/p.png" style="width:50%">',
  );
  f.editor.querySelector("img")!.click();
  await settle();
  expect(document.querySelector('[aria-label="图片设置"]')).toBeNull();
  expect(f.editor.querySelector("img")!.style.width).toBe("50%");
  expect(f.update).not.toHaveBeenCalled();
});

it("cancelling a description link leaves its selected text and saved markup unchanged", async () => {
  const f = await mount();
  const original = f.editor.innerHTML;
  f.editor.focus();
  const range = document.createRange();
  range.selectNodeContents(f.editor.querySelector("p")!);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  button("插入链接").click();
  await settle();
  const address = document.querySelector<HTMLInputElement>('[id$="-link"]')!;
  address.value = "https://example.com/not-applied";
  address.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  button("取消").click();
  await settle();
  expect(f.editor.innerHTML).toBe(original);
  expect(f.exec).not.toHaveBeenCalled();
  expect(f.update.mock.calls.every(([value]) => value === original)).toBe(true);
  expect(document.querySelector('[id$="-link"]')).toBeNull();
});

it("multi-line defaults preserve line breaks through configuration, save and filling defaults", async () => {
  const field = reactive(createField("textarea")),
    schema = emptySchema();
  schema.fields = [field];
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(FieldInspector, {
    field,
    schema,
    formId: "test",
    onUpdate: (patch: any) => Object.assign(field, patch),
  });
  app.use(createPinia());
  app.mount("#mount");
  await settle();
  const input = document.querySelector<HTMLTextAreaElement>(
    "textarea#field-default",
  )!;
  expect(input).toBeDefined();
  expect(document.querySelector("#field-length")).toBeNull();
  input.value = "第一行\n第二行";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  const restored = parseSchema(JSON.parse(JSON.stringify(schema)));
  expect(defaultValues(restored.fields)[field.id]).toBe("第一行\n第二行");
  expect(restored.fields[0]!.maxLength).toBe(0);
  const long = "完整说明".repeat(150);
  expect(validateValues(restored, { [field.id]: long })).toEqual([]);
  const legacy = JSON.parse(JSON.stringify(schema));
  legacy.fields[0].maxLength = 200;
  expect(
    validateValues(parseSchema(legacy), { [field.id]: long })[0]?.message,
  ).toContain("200");
  delete legacy.fields[0].maxLength;
  expect(parseSchema(legacy).fields[0]!.maxLength).toBe(200);
  field.maxLength = 200;
  await settle();
  const limit = document.querySelector<HTMLInputElement>("#field-length")!;
  expect(limit.value).toBe("200");
  limit.value = "0";
  limit.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(field.maxLength).toBe(0);
  expect(document.querySelector("#field-length")).toBeNull();
});

const setInput = async (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};
function selectContents(element: Node) {
  const range = document.createRange();
  range.selectNodeContents(element);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}
it("edits existing text links without nested anchors, keeps unchanged formatting and cancels text/target changes", async () => {
  const f = await mount(
    false,
    '<p>前文<a href="https://example.com/old"><b>业务说明</b></a>后文</p>',
  );
  const open = async () => {
    f.editor.focus();
    selectContents(f.editor.querySelector("b")!.firstChild!);
    button("插入链接").click();
    await settle();
  };
  await open();
  expect(
    document.querySelector<HTMLInputElement>('[id$="-link-text"]')!.value,
  ).toBe("业务说明");
  await setInput('[id$="-link"]', "https://example.com/new");
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await settle();
  button("确定").click();
  await settle();
  expect(f.editor.querySelectorAll("a")).toHaveLength(1);
  expect(f.editor.querySelector("a")!.target).toBe("_self");
  expect(f.editor.querySelector("a b")!.textContent).toBe("业务说明");
  await open();
  expect(
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
  ).toBe(false);
  const original = f.editor.innerHTML;
  await setInput('[id$="-link-text"]', "不会应用的文字");
  button("取消").click();
  await settle();
  expect(f.editor.innerHTML).toBe(original);
  await open();
  await setInput('[id$="-link-text"]', "");
  button("确定").click();
  await settle();
  expect(document.querySelector('[role="status"]')!.textContent).toContain(
    "显示文本",
  );
  await setInput('[id$="-link-text"]', "<说明 & 详情>");
  button("确定").click();
  await settle();
  expect(f.editor.textContent).toBe("前文<说明 & 详情>后文");
  expect(f.editor.querySelectorAll("a")).toHaveLength(1);
  expect(f.editor.querySelector("a")!.href).toBe("https://example.com/new");
  expect(f.editor.querySelector("说明")).toBeNull();
});
it("inserts a named link at an empty caret and closes stale dialogs after an external edit", async () => {
  const f = await mount(false, "<p>前文</p>");
  f.editor.focus();
  selectContents(f.editor.querySelector("p")!);
  document.getSelection()!.collapseToEnd();
  button("插入链接").click();
  await settle();
  await setInput('[id$="-link"]', "https://example.com/help");
  await setInput('[id$="-link-text"]', "查看说明");
  button("确定").click();
  await settle();
  expect(f.editor.textContent).toBe("前文查看说明");
  expect(f.editor.querySelector("a")!.target).toBe("_blank");
  button("插入链接").click();
  await settle();
  document.querySelector<HTMLInputElement>('[id$="-link"]')!.focus();
  f.state.value = "<p>另一个字段</p>";
  await settle();
  expect(document.querySelector('[id$="-link"]')).toBeNull();
  expect(f.editor.textContent).toBe("另一个字段");
});
it("validates the shared image count, byte and type boundaries before reading a batch", async () => {
  const file = { type: "image/png", size: 1024 * 1024 };
  expect(richImageFilesIssue(Array(10).fill(file))).toBe("");
  expect(richImageFilesIssue(Array(11).fill(file))).toContain("10");
  expect(richImageFilesIssue([{ ...file, size: file.size + 1 }])).toContain(
    "1 MB",
  );
  expect(richImageFilesIssue([{ ...file, type: "image/svg+xml" }])).toContain(
    "PNG",
  );
  await expect(
    richImageFilesHtml([
      new File(["bad"], "bad.svg", { type: "image/svg+xml" }),
    ]),
  ).rejects.toThrow("PNG");
});
it("stages images without changing the editor, rejects an invalid addition atomically, and cancels or inserts a batch", async () => {
  const f = await mount();
  const original = f.editor.innerHTML;
  const files = [
    new File(["first"], "一.png", { type: "image/png" }),
    new File(["second"], "二.gif", { type: "image/gif" }),
  ];
  const choose = async (files: File[]) => {
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  };
  button("插入图片").click();
  await settle();
  await choose(files);
  await choose([new File(["bad"], "bad.svg", { type: "image/svg+xml" })]);
  expect(document.querySelectorAll(".image-file-list li")).toHaveLength(2);
  expect(f.editor.innerHTML).toBe(original);
  button("取消").click();
  await settle();
  expect(f.editor.innerHTML).toBe(original);
  button("插入图片").click();
  await settle();
  expect(document.querySelector(".image-file-list")).toBeNull();
  await choose(files);
  button("确定").click();
  await vi.waitFor(() =>
    expect(f.editor.querySelectorAll("img")).toHaveLength(2),
  );
  expect(
    Array.from(f.editor.querySelectorAll("img")).map((e) => e.alt),
  ).toEqual(["一.png", "二.gif"]);
  expect(
    document.querySelector('[aria-label="插入图片"][role="dialog"]'),
  ).toBeNull();
});
it("inserts only an explicit valid image URL and leaves content untouched on invalid input", async () => {
  const f = await mount();
  button("插入图片").click();
  await settle();
  button("图片网址").click();
  await settle();
  await setInput('[id$="-image-url"]', "javascript:alert(1)");
  button("确定").click();
  await settle();
  expect(f.editor.querySelector("img")).toBeNull();
  expect(document.querySelector('[role="status"]')!.textContent).toContain(
    "图片地址",
  );
  await setInput('[id$="-image-url"]', "https://example.com/image.png");
  button("确定").click();
  await settle();
  expect(f.editor.querySelector("img")!.src).toBe(
    "https://example.com/image.png",
  );
});
it("pastes clipboard image files once, shares size errors, and preserves content changed while reading", async () => {
  const f = await mount();
  const paste = (files: File[]) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files,
        getData: () => '<img src="https://example.com/duplicate.png">',
      },
    });
    f.editor.dispatchEvent(event);
  };
  f.editor.focus();
  selectContents(f.editor.querySelector("p")!);
  document.getSelection()!.collapseToEnd();
  paste([new File(["image"], "粘贴.png", { type: "image/png" })]);
  await vi.waitFor(() =>
    expect(f.editor.querySelectorAll("img")).toHaveLength(1),
  );
  expect(f.editor.querySelector("img")!.src).toMatch(/^data:image\/png/);
  expect(f.editor.textContent).toBe("业务说明");
  const before = f.editor.innerHTML;
  paste([
    new File([new Uint8Array(1024 * 1024 + 1)], "大图.png", {
      type: "image/png",
    }),
  ]);
  await settle();
  expect(document.querySelector('[role="status"]')!.textContent).toContain(
    "1 MB",
  );
  expect(f.editor.innerHTML).toBe(before);
  paste([new File(["next"], "稍后.png", { type: "image/png" })]);
  f.state.value = "新的外部内容";
  await vi.waitFor(() => expect(f.state.value).toBe("新的外部内容"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.state.value).toBe("新的外部内容");
});

it("retains field headings, lists, indentation, strike and highlight through save and text summaries", () => {
  const value =
    '<h2>检查结果</h2><blockquote style="position:fixed;background-image:url(https://example.com/x)"><ul><li><s>旧方案</s></li><li><span style="background-color:#fff2cc;text-decoration:underline line-through">新方案</span></li></ul></blockquote>';
  const safe = sanitizeRichText(value);
  const root = html(safe);
  expect(root.querySelector("h2")!.textContent).toBe("检查结果");
  expect(root.querySelectorAll("blockquote li")).toHaveLength(2);
  expect(root.querySelector("s")!.textContent).toBe("旧方案");
  expect(root.querySelector("span")!.style.backgroundColor).toBe(
    "rgb(255, 242, 204)",
  );
  expect(root.querySelector("span")!.style.textDecoration).toBe(
    "underline line-through",
  );
  expect(root.querySelector("blockquote")!.hasAttribute("style")).toBe(false);
  expect(sanitizeRichText(safe)).toBe(safe);
  expect(richTextPlainText(safe)).toBe("检查结果\n旧方案\n新方案");
  const schema = emptySchema();
  schema.fields = [createField("richtext", { defaultValue: safe })];
  expect(
    defaultValues(parseSchema(JSON.parse(JSON.stringify(schema))).fields)[
      schema.fields[0]!.id
    ],
  ).toBe(safe);
});
it("field tools retain the selection for native editing without adding tools to descriptions", async () => {
  const f = await mount(false, "<p>待编辑正文</p>", "field");
  for (const [label, command] of [
    ["有序列表", "insertOrderedList"],
    ["无序列表", "insertUnorderedList"],
    ["增加缩进", "indent"],
    ["减少缩进", "outdent"],
    ["删除线", "strikeThrough"],
    ["撤销", "undo"],
    ["重做", "redo"],
  ]) {
    f.editor.focus();
    selectContents(f.editor.querySelector("p")!);
    let selected = "";
    f.exec.mockImplementation((action) => {
      if (action === command) selected = document.getSelection()!.toString();
      return true;
    });
    button(label!).click();
    await settle();
    expect(f.exec).toHaveBeenCalledWith(command, false, undefined);
    expect(selected).toBe("待编辑正文");
  }
  button("清除格式").click();
  expect(f.exec).toHaveBeenCalledWith("removeFormat", false);
  expect(f.exec).toHaveBeenCalledWith("justifyLeft", false);
  f.state.readonly = true;
  await settle();
  expect(document.querySelector(".rich-toolbar")).toBeNull();
  const before = f.exec.mock.calls.length;
  f.editor.dispatchEvent(
    new Event("paste", { bubbles: true, cancelable: true }),
  );
  expect(f.exec.mock.calls.length).toBe(before);
});
it("keeps the compact description toolbar and its original image size limit", async () => {
  await mount();
  expect(button("增加缩进")).toBeUndefined();
  expect(button("文字大小")).toBeUndefined();
  expect(document.querySelector('[aria-label="文字大小"]')).not.toBeNull();
  button("插入图片").click();
  await settle();
  expect(document.body.textContent).toContain("1 MB");
});
it("applies 5 MB field image boundaries and counts images across successive inserts", async () => {
  const limit = 5 * 1024 * 1024;
  expect(richImageFilesIssue([{ type: "image/png", size: limit }], 5)).toBe("");
  expect(
    richImageFilesIssue([{ type: "image/png", size: limit + 1 }], 5),
  ).toContain("5 MB");
  const images = Array.from(
    { length: 10 },
    (_, i) => `<img src="https://example.com/${i}.png">`,
  ).join("");
  const f = await mount(false, images, "field");
  f.editor.focus();
  selectContents(f.editor);
  document.getSelection()!.collapseToEnd();
  button("插入图片").click();
  await settle();
  expect(document.body.textContent).toContain("5 MB");
  expect(button("选择图片").disabled).toBe(true);
  button("图片网址").click();
  await settle();
  await setInput('[id$="-image-url"]', "https://example.com/overflow.png");
  button("确定").click();
  await settle();
  expect(document.querySelector('[role="status"]')!.textContent).toContain(
    "数量上限",
  );
  expect(f.editor.querySelectorAll("img")).toHaveLength(10);
  button("取消").click();
  await settle();
  // Replacing an existing selection frees its image slot, rather than requiring deletion first.
  const range = document.createRange();
  range.selectNode(f.editor.querySelector("img")!);
  f.editor.focus();
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  button("插入图片").click();
  await settle();
  expect(button("选择图片").disabled).toBe(false);
  button("图片网址").click();
  await settle();
  await setInput('[id$="-image-url"]', "https://example.com/replaced.png");
  button("确定").click();
  await settle();
  expect(f.editor.querySelectorAll("img")).toHaveLength(10);
  expect(
    f.editor.querySelector('img[src="https://example.com/replaced.png"]'),
  ).not.toBeNull();
});
it("pastes rich field text and formatting without inserting external clipboard images", async () => {
  const f = await mount(false, "", "field");
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      getData: (type: string) =>
        type === "text/html"
          ? '<h2>粘贴标题</h2><p>正文<img src="https://example.com/p.png" onerror="alert(1)"></p>'
          : "",
    },
  });
  f.editor.dispatchEvent(event);
  await settle();
  expect(f.editor.querySelector("h2")!.textContent).toBe("粘贴标题");
  expect(f.editor.querySelector("img")).toBeNull();
  expect(f.editor.textContent).toBe("粘贴标题正文");
});

it("stores a large field image in the existing file repository and reloads its reference without serializing a blob URL", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  const urls = vi.fn(() => "blob:rich-test");
  const revoked = vi.fn();
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = urls;
      static revokeObjectURL = revoked;
    },
  );
  const f = await mount(false, "<h2>图文说明</h2>", "field");
  f.editor.focus();
  selectContents(f.editor);
  document.getSelection()!.collapseToEnd();
  button("插入图片").click();
  await settle();
  const file = new File([new Uint8Array(2 * 1024 * 1024)], "large.png", {
    type: "image/png",
  });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  button("确定").click();
  await vi.waitFor(() =>
    expect(f.editor.querySelector("img")?.src).toBe("blob:rich-test"),
  );
  const id = f.editor.querySelector("img")!.dataset.fileId!;
  const saved = f.state.value;
  expect(saved).toContain(`data-file-id="${id}"`);
  expect(saved).not.toContain("blob:");
  expect(saved.length).toBeLessThan(200);
  expect(
    (await readFile({ id, name: file.name, size: file.size, type: file.type }))
      .size,
  ).toBe(file.size);
  app!.unmount();
  expect(revoked).toHaveBeenCalledWith("blob:rich-test");
  const reloaded = await mount(true, saved, "field");
  await vi.waitFor(() =>
    expect(reloaded.editor.querySelector("img")?.src).toBe("blob:rich-test"),
  );
  expect(reloaded.editor.querySelector("h2")!.textContent).toBe("图文说明");
  expect(reloaded.update).not.toHaveBeenCalled();
});
it("renders formatted record details through the readonly editor while excluding hidden fields", async () => {
  const schema = emptySchema();
  schema.fields = [
    createField("richtext", { id: "report", label: "检查记录" }),
    createField("richtext", {
      id: "secret",
      label: "隐藏内容",
      visible: false,
    }),
  ];
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(RecordBody, {
    schema,
    values: {
      report: "<h2>标题</h2><ol><li><s>原方案</s></li><li>新方案</li></ol>",
      secret: "<h1>不应显示</h1>",
    },
    settings: defaultDetailSettings(),
    interactive: true,
  });
  app.use(createPinia());
  app.mount("#mount");
  await settle();
  expect(document.querySelector("h2")!.textContent).toBe("标题");
  expect(document.querySelectorAll("ol li")).toHaveLength(2);
  expect(document.querySelector("s")!.textContent).toBe("原方案");
  expect(document.body.textContent).not.toContain("不应显示");
  expect(document.querySelector(".rich-toolbar")).toBeNull();
});
