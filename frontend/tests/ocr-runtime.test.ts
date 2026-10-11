// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import {
  ocrTemplate,
  identifySubformRows,
  newSubformPermissions,
  type FrontendEvent,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  copy,
  type FormValues,
} from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
const quantity = ocrTemplate("vatInvoice")!.contents.find(
  (c) => c.label === "数量",
)!;
const scan = () =>
  createField("ocr", {
    id: "scan",
    label: "识别发票",
    ocr: {
      type: "vatInvoice",
      mappings: [{ contentId: quantity.id, fieldId: "qty" }],
    },
  });
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 12; i++) await nextTick();
};
async function mount(props: any) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(() => h(FormRuntime, props));
  app.use(createPinia()).use(router).mount("#mount");
  await settle();
}
const response = (value: unknown) =>
  new Response(
    JSON.stringify({ type: "vatInvoice", values: { [quantity.id]: value } }),
    { headers: { "content-type": "application/json" } },
  );
async function start() {
  document.querySelector<HTMLButtonElement>(".ocr-action")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector('input[type="file"]')).toBeTruthy(),
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [new File(["SYN"], "SYN.png", { type: "image/png" })],
    configurable: true,
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}
const recognize = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button"))
    .find((b) => ["识别", "重试识别"].includes(b.textContent!.trim()))!
    .click();
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv("VITE_OCR_ENDPOINT", "/api/ocr/recognize");
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:SYN"),
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("member OCR fills trigger the existing event pipeline and calculated fields together", async () => {
  const schema = emptySchema();
  schema.settings.cacheDraft = false;
  schema.fields = [
    scan(),
    createField("number", { id: "qty", label: "数量" }),
    createField("number", { id: "price", label: "单价" }),
    createField("number", { id: "amount", label: "金额" }),
    createField("calculated", {
      id: "double",
      label: "双倍金额",
      expression: "{{amount}} * 2",
    }),
  ];
  schema.settings.frontendEvents = [
    {
      id: "evt",
      name: "乘法",
      description: "",
      enabled: true,
      trigger: "field",
      fieldIds: ["qty"],
      plugin: {
        actionId: "multiply",
        inputs: {
          quantity: { source: "field", value: "qty" },
          price: { source: "field", value: "price" },
        },
        outputs: [{ outputKey: "amount", fieldId: "amount" }],
      },
    } as FrontendEvent,
  ];
  const onChange = vi.fn();
  vi.mocked(fetch).mockResolvedValueOnce(response([3]));
  await mount({
    schema,
    formId: "SYN-runtime",
    initialValues: { qty: 1, price: 5, amount: 5 },
    onChange,
  });
  await start();
  onChange.mockClear();
  recognize();
  await settle();
  await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(onChange.mock.calls.at(-1)![0]).toMatchObject({
    qty: 3,
    price: 5,
    amount: 15,
    double: 30,
  });
  expect(
    document
      .querySelector('input[aria-label="金额"]')!
      .getAttribute("disabled"),
  ).toBeNull();
  expect(document.querySelector("dialog[open]")).toBeNull();
});
it("OCR cannot bypass existing-row edits and retries retain the image and original cells", async () => {
  const schema = emptySchema();
  schema.settings.cacheDraft = false;
  schema.fields = [
    scan(),
    createField("subform", {
      id: "rows",
      label: "明细",
      children: [createField("number", { id: "qty", label: "数量" })],
      subformPermissions: { ...newSubformPermissions(), editExisting: false },
    }),
  ];
  const initial = identifySubformRows(schema.fields, { rows: [{ qty: 1 }] }),
    onChange = vi.fn();
  vi.mocked(fetch).mockResolvedValueOnce(response([9]));
  await mount({
    schema,
    formId: "SYN-runtime",
    initialValues: initial,
    rowBaseline: initial,
    rowPermissionMode: "record",
    onChange,
  });
  await start();
  onChange.mockClear();
  recognize();
  await settle();
  await vi.waitFor(() =>
    expect(
      document.querySelector('dialog [role="alert"]')!.textContent,
    ).toContain("不可编辑已有记录"),
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(
    (
      document.querySelector(
        'input[aria-label="明细 第1行 数量"]',
      ) as HTMLInputElement
    ).value,
  ).toBe("1");
  expect(document.querySelector("dialog img")).toBeTruthy();
});
it("late results are discarded after current values change and a fresh retry can use the new baseline", async () => {
  const schema = emptySchema();
  schema.settings.cacheDraft = false;
  schema.fields = [scan(), createField("number", { id: "qty", label: "数量" })];
  let finish!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const props = reactive({
    schema,
    formId: "SYN-runtime",
    initialValues: { qty: 1 },
    onChange: vi.fn(),
  });
  await mount(props);
  await start();
  recognize();
  await settle();
  props.initialValues = { qty: 4 };
  await settle();
  finish(response([9]));
  await settle();
  expect(
    (document.querySelector('input[aria-label="数量"]') as HTMLInputElement)
      .value,
  ).toBe("4");
  expect(
    document.querySelector('dialog [role="alert"]')!.textContent,
  ).toContain("表单已变化");
  vi.mocked(fetch).mockResolvedValueOnce(response([6]));
  props.onChange.mockClear();
  recognize();
  await settle();
  await vi.waitFor(() => expect(props.onChange).toHaveBeenCalled());
  expect(props.onChange.mock.calls.at(-1)![0].qty).toBe(6);
});
it("published OCR targets remain immutable and ordinary mapped results survive same-ID draft submission and a cold repository read", async () => {
  const store = useWorkspaceStore(createPinia()),
    created = (await store.createForm("oa", "SYN-OCR版本验收", "form"))!,
    form = store.openForm(created.id)!;
  const old = createField("ocr", { id: "old" });
  delete old.ocr;
  form.schema.fields = [old];
  expect(await store.publishForm(form.id)).toBeTruthy();
  const record = (await store.submitEntry(form.id, { old: "SYN-旧文本" }))!;
  const draftForm = store.openForm(form.id)!;
  const configured = emptySchema();
  configured.fields = [scan(), createField("number", { id: "qty" })];
  draftForm.schema = configured;
  expect(await store.publishForm(form.id)).toBeTruthy();
  const version = copy(
    store.data.forms.find((f) => f.id === form.id)!.published!.schema,
  );
  const draft = (await store.submitEntry(form.id, { qty: 3 }, "draft"))!;
  const submitted = (await store.submitEntry(
    form.id,
    { qty: 3 },
    "submitted",
    draft.id,
  ))!;
  expect(submitted.id).toBe(draft.id);
  store.openForm(form.id)!.schema.fields[0]!.ocr!.mappings = [];
  expect(
    store.data.forms.find((f) => f.id === form.id)!.published!.schema,
  ).toEqual(version);
  const cold = useWorkspaceStore(createPinia());
  await cold.refreshForRead();
  const records = cold.data.entries.filter((e) => e.formId === form.id);
  expect(records).toHaveLength(2);
  expect(records.find((e) => e.id === record.id)!.values.old).toBe(
    "SYN-旧文本",
  );
  expect(records.find((e) => e.id === draft.id)!).toMatchObject({
    definitionVersion: 2,
    values: { qty: 3 },
  });
});
