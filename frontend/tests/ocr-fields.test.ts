import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import {
  ocrTemplates,
  ocrTemplate,
  separateFormSchema,
  composeFormSchema,
  type FormField,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  duplicateFields,
  copy,
} from "../src/domain/form";
import {
  configureOcr,
  matchOcrTargets,
  ocrConfigurationErrors,
  applyOcrResult,
  ocrTargets,
} from "../src/domain/ocr";

import { ocrImageIssue, recognizeOcr } from "../src/services/ocr";

import OcrRecognitionDialog from "../src/features/forms/components/OcrRecognitionDialog.vue";
import FieldControl from "../src/features/forms/components/FieldControl.vue";
import { saveFiles } from "../src/repositories/fileRepository";
vi.mock("../src/repositories/fileRepository", () => ({
  saveFiles: vi.fn(async (files: File[]) =>
    files.map((file) => ({
      id: "file_local",
      name: file.name,
      size: file.size,
      type: file.type,
    })),
  ),
}));
const data = () => seedWorkspace();
const content = (type: string, label: string) =>
  ocrTemplate(type)!.contents.find((item) => item.label === label)!;
const schema = (...fields: FormField[]) => ({ ...emptySchema(), fields });
const general = (target: FormField) =>
  schema(
    createField("ocr", {
      id: "scan",
      ocr: {
        type: "general",
        mappings: [
          { contentId: content("general", "识别内容").id, fieldId: target.id },
        ],
      },
    }),
    target,
  );
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 12; i++) await nextTick();
};
function mount(component: any, props: any) {
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(() => h(component, props));
  app.use(createPinia());
  app.mount("#mount");
}
const button = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent!.trim() === text,
  )!;
const image = () =>
  new File(["SYN-image-bytes"], "SYN-ocr.png", { type: "image/png" });
function pick(file: File, index = 0) {
  const input =
    document.querySelectorAll<HTMLInputElement>('input[type="file"]')[index]!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
const response = (type: string, values: Record<string, unknown>) =>
  new Response(JSON.stringify({ type, values }), {
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  vi.stubEnv("VITE_OCR_ENDPOINT", "");
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:SYN-image"),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.mocked(saveFiles).mockClear();
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("offers eight documented templates including original images, typed dates and invoice detail outputs", () => {
  expect(ocrTemplates.map((t) => t.label)).toEqual([
    "通用文字",
    "身份证",
    "增值税发票",
    "营业执照",
    "驾驶证",
    "行驶证",
    "银行卡",
    "火车票",
  ]);
  expect(ocrTemplates.reduce((n, t) => n + t.contents.length, 0)).toBe(92);
  expect(content("idCard", "出生日期").defaultType).toBe("datetime");
  expect(content("idCard", "地址").types).toEqual([
    "text",
    "textarea",
    "address",
  ]);
  expect(content("vatInvoice", "数量").detail).toBe(true);
  expect(content("bankCard", "银行卡卡号").defaultType).toBe("text");
});
it("creates outputs and mappings atomically, preserves tab placement and remaps copied targets", () => {
  const ocr = createField("ocr", {
    id: "scan",
    ocr: { type: "general", mappings: [] },
    tabId: "tab1",
  });
  const tabs = createField("tabs", {
    id: "tabs",
    tabs: [{ id: "tab1", label: "甲" }],
    children: [ocr],
  });
  const original = schema(tabs),
    before = copy(original);
  const next = configureOcr(
    original,
    "scan",
    "general",
    ocrTemplate("general")!.contents.map((c) => c.id),
    "new",
  );
  expect(original).toEqual(before);
  expect(next.fields[0]!.children).toHaveLength(3);
  const outputs = next.fields[0]!.children.slice(1);
  expect(outputs.map((f) => f.type)).toEqual(["image", "text"]);
  expect(outputs.every((f) => f.tabId === "tab1")).toBe(true);
  const copied = duplicateFields(next.fields).fields[0]!.children;
  expect(copied[0]!.ocr!.mappings.map((m) => m.fieldId)).toEqual(
    copied.slice(1).map((f) => f.id),
  );
  const separated = separateFormSchema(next);
  expect(
    composeFormSchema(separated.model, separated.page).fields[0]!.children[0]!
      .ocr,
  ).toEqual(next.fields[0]!.children[0]!.ocr);
});
it("matches only unique compatible names and rejects duplicate, missing, incompatible or over-capacity rules without mutation", () => {
  const c = content("general", "识别内容"),
    a = createField("text", { id: "a", label: c.label }),
    b = createField("text", { id: "b", label: c.label });
  const source = general(a);
  expect(matchOcrTargets(source, "general", [c.id])[0]!.fieldId).toBe("a");
  expect(
    matchOcrTargets(schema(source.fields[0]!, a, b), "general", [c.id])[0]!
      .fieldId,
  ).toBe("");
  expect(matchOcrTargets(source, "general", ["removed"])[0]!.fieldId).toBe("");
  expect(() =>
    configureOcr(source, "scan", "general", [c.id], "existing", [
      { contentId: c.id, fieldId: "missing" },
    ]),
  ).toThrow("类型不匹配");
  expect(() => configureOcr(source, "scan", "general", [], "new")).toThrow(
    "请选择",
  );
  const full = schema(
    source.fields[0]!,
    ...Array.from({ length: 299 }, (_, i) =>
      createField("text", { id: `f${i}` }),
    ),
  );
  expect(() => configureOcr(full, "scan", "general", [c.id], "new")).toThrow(
    "数量超限",
  );
  expect(full.fields).toHaveLength(300);
  expect(() =>
    parseSchema(
      schema({
        ...source.fields[0]!,
        ocr: {
          type: "general",
          mappings: [
            { contentId: c.id, fieldId: "a" },
            { contentId: c.id, fieldId: "b" },
          ],
        },
      }),
    ),
  ).toThrow("规则配置无效");
});
it("preserves historical text OCR instead of opting old definitions into image actions", async () => {
  const legacy = createField("ocr", { id: "legacy" });
  delete legacy.ocr;
  const parsed = parseSchema(schema(legacy));
  expect(parsed.fields[0]!.ocr).toBeUndefined();
  mount(FieldControl, {
    field: parsed.fields[0],
    modelValue: "旧识别文本",
    readonly: true,
  });
  await settle();
  expect(document.querySelector("textarea")!.value).toBe("旧识别文本");
  expect(document.querySelector("textarea")!.disabled).toBe(true);
  expect(document.querySelector(".ocr-action")).toBeNull();
});
it("fills ordinary fields with their precision and formulas while preserving missing recognition and readonly data", () => {
  const amount = createField("number", { id: "amount", precision: 0 }),
    code = createField("text", { id: "code" });
  const calc = createField("calculated", {
    id: "calc",
    expression: "{{amount}} * 2",
  });
  const f = createField("ocr", {
    id: "scan",
    ocr: {
      type: "vatInvoice",
      mappings: [
        { contentId: content("vatInvoice", "合计金额").id, fieldId: "amount" },
        { contentId: content("vatInvoice", "发票代码").id, fieldId: "code" },
      ],
    },
  });
  const s = schema(f, amount, code, calc),
    before = { amount: 2, code: "原代码", unrelated: "保留" };
  const values = applyOcrResult(
    s,
    "scan",
    before,
    {
      [content("vatInvoice", "合计金额").id]: 6.887,
      [content("vatInvoice", "发票代码").id]: "000123",
    },
    data(),
  );
  expect(values.amount).toBe(7);
  expect(values.code).toBe("000123");
  expect(values.calc).toBe(14);
  expect(before.amount).toBe(2);
  expect(values.unrelated).toBe("保留");
  expect(
    applyOcrResult(
      s,
      "scan",
      before,
      {
        [content("vatInvoice", "合计金额").id]: 0,
        [content("vatInvoice", "发票代码").id]: null,
      },
      data(),
    ),
  ).toMatchObject({ amount: 0, code: "原代码" });
  expect(() => applyOcrResult(s, "scan", before, {}, data())).toThrow(
    "未识别到",
  );
  amount.editable = false;
  expect(() =>
    applyOcrResult(
      s,
      "scan",
      before,
      { [content("vatInvoice", "合计金额").id]: 6 },
      data(),
    ),
  ).toThrow("不可编辑");
  expect(before.amount).toBe(2);
});
it("fills invoice columns as rows up to source limit, preserves other cells and rejects readonly or wrong-scope columns", () => {
  const qty = content("vatInvoice", "数量"),
    child = createField("number", { id: "qty", precision: 0 }),
    note = createField("text", { id: "note" });
  const table = createField("subform", { id: "rows", children: [child, note] });
  const f = createField("ocr", {
      id: "scan",
      ocr: {
        type: "vatInvoice",
        mappings: [{ contentId: qty.id, fieldId: "qty" }],
      },
    }),
    s = schema(f, table);
  expect(ocrConfigurationErrors(f, s)).toEqual([]);
  expect(
    ocrTargets(s, content("general", "识别内容")).some((f) => f.id === "note"),
  ).toBe(false);
  const before = { rows: [{ _rowId: "old", qty: 1, note: "保留" }] };
  const next = applyOcrResult(
    s,
    "scan",
    before,
    { [qty.id]: [2.4, "2.8"] },
    data(),
  );
  expect(next.rows).toEqual([
    { _rowId: "old", qty: 2, note: "保留" },
    { qty: 3, note: "" },
  ]);
  expect(before.rows[0]!.qty).toBe(1);
  expect(
    applyOcrResult(
      s,
      "scan",
      {},
      { [qty.id]: Array.from({ length: 201 }, () => 1) },
      data(),
    ).rows as unknown[],
  ).toHaveLength(200);
  child.editable = false;
  expect(() =>
    applyOcrResult(s, "scan", before, { [qty.id]: [2] }, data()),
  ).toThrow("不可编辑");
});
it("rejects a readonly ancestor and incompatible output without changing any values", () => {
  const target = createField("text", { id: "text" }),
    s = general(target),
    before = { text: "原值" };
  s.fields = [
    createField("tabs", { id: "group", editable: false, children: s.fields }),
  ];
  expect(() =>
    applyOcrResult(
      s,
      "scan",
      before,
      { [content("general", "识别内容").id]: "新值" },
      data(),
    ),
  ).toThrow("不可编辑");
  expect(() =>
    applyOcrResult(
      general(target),
      "scan",
      before,
      { [content("general", "识别内容").id]: {} },
      data(),
    ),
  ).toThrow("需要文本");
  expect(before.text).toBe("原值");
});

it("validates image inputs and reports unavailable service without network or fake success", async () => {
  expect(
    ocrImageIssue(new File(["x"], "x.svg", { type: "image/svg+xml" })),
  ).toContain("JPG");
  expect(ocrImageIssue(new File([], "x.png", { type: "image/png" }))).toContain(
    "为空",
  );
  await expect(
    recognizeOcr(
      "general",
      [{ side: "front", file: image() }],
      new AbortController().signal,
    ),
  ).rejects.toThrow("尚未启用");
  expect(fetch).not.toHaveBeenCalled();
  const apply = vi.fn();
  mount(OcrRecognitionDialog, {
    field: general(createField("text", { id: "t" })).fields[0],
    schema: emptySchema(),
    values: {},
    apply,
  });
  await settle();
  pick(image());
  await settle();
  button("识别").click();
  await settle();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "尚未启用",
  );
  expect(button("重试识别").disabled).toBe(false);
  expect(document.querySelector("img")).toBeTruthy();
  expect(apply).not.toHaveBeenCalled();
});
it("uses the real multipart adapter contract and supports network failure retry and malformed response errors", async () => {
  vi.stubEnv("VITE_OCR_ENDPOINT", "/api/ocr/recognize");
  const fetcher = vi.mocked(fetch);
  fetcher
    .mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValueOnce(response("general", { general_02: "SYN-text" }));
  const inputs = [{ side: "front" as const, file: image() }];
  await expect(
    recognizeOcr("general", inputs, new AbortController().signal),
  ).rejects.toThrow("无法连接");
  expect(
    await recognizeOcr("general", inputs, new AbortController().signal),
  ).toEqual({ general_02: "SYN-text" });
  const request = fetcher.mock.calls[1]![1]!;
  expect((request.body as FormData).get("type")).toBe("general");
  expect((request.body as FormData).get("front")).toBeInstanceOf(File);
  fetcher.mockResolvedValueOnce(response("bankCard", {}));
  await expect(
    recognizeOcr("general", inputs, new AbortController().signal),
  ).rejects.toThrow("格式无效");
  fetcher.mockResolvedValueOnce(new Response("Too many", { status: 429 }));
  await expect(
    recognizeOcr("general", inputs, new AbortController().signal),
  ).rejects.toThrow("过多");
});
it("timeouts abort the network operation and preserve a distinct cancellation reason", async () => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_OCR_ENDPOINT", "/api/ocr/recognize");
  vi.mocked(fetch).mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  const run = recognizeOcr(
    "general",
    [{ side: "front", file: image() }],
    new AbortController().signal,
  ).catch((e) => e.message);
  await vi.advanceTimersByTimeAsync(30000);
  expect(await run).toContain("超时");
  const controller = new AbortController();
  const canceled = recognizeOcr(
    "general",
    [{ side: "front", file: image() }],
    controller.signal,
  ).catch((e) => e.message);
  controller.abort();
  expect(await canceled).toBe("识别已取消");
});
it("never trusts service image metadata and ignores recognition that arrives after permissions change", async () => {
  vi.stubEnv("VITE_OCR_ENDPOINT", "/api/ocr/recognize");
  const template = ocrTemplate("idCard")!,
    front = content("idCard", "身份证人像面原件"),
    back = content("idCard", "身份证国徽面原件"),
    name = content("idCard", "姓名");
  const field = createField("ocr", {
      id: "scan",
      ocr: {
        type: template.value,
        mappings: [
          { contentId: front.id, fieldId: "image1" },
          { contentId: back.id, fieldId: "image2" },
          { contentId: name.id, fieldId: "name" },
        ],
      },
    }),
    apply = vi.fn();
  const props = reactive({
    field,
    schema: schema(field),
    values: {},
    disabled: false,
    apply,
  });
  vi.mocked(fetch).mockResolvedValueOnce(
    response("idCard", {
      [front.id]: [
        {
          id: "secret_other_file",
          name: "fake.png",
          size: 1,
          type: "image/png",
        },
      ],
      [back.id]: [
        {
          id: "secret_back_file",
          name: "fake.png",
          size: 1,
          type: "image/png",
        },
      ],
      [name.id]: "SYN-name",
    }),
  );
  mount(OcrRecognitionDialog, props);
  await settle();
  pick(image());
  await settle();
  button("识别").click();
  await settle();
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0]![0][front.id][0].id).toBe("file_local");
  expect(apply.mock.calls[0]![0][back.id]).toBeUndefined();
  let complete!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  apply.mockClear();
  button("识别").click();
  await settle();
  props.disabled = true;
  await settle();
  complete(response("idCard", { [name.id]: "late" }));
  await settle();
  expect(apply).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "表单已变化",
  );
});
