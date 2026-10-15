// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";
import { selectionCountMessage, type ChoiceValue } from "@platform/contracts";
import { createField } from "../src/domain/form";
import ChoiceFieldControl from "../src/features/forms/components/ChoiceFieldControl.vue";
import FieldControl from "../src/features/forms/components/FieldControl.vue";
import ServerFieldControl from "../src/features/collaboration/ServerFieldControl.vue";

const options = [
  { id: "a", label: "销售部" },
  { id: "b", label: "质量部" },
  { id: "c", label: "仓储部" },
];
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
// 字段容器也带无障碍名称；交互需定位内部控件，不能点击或修改外层分组。
const control = <T extends HTMLElement = HTMLInputElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]:not(.server-field-control)`)!;
async function mount(render: Parameters<typeof createApp>[0]) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(render);
  app.use(createPinia());
  app.mount("#app");
  await settle();
}
async function search(text: string) {
  const input = control("部门搜索选项");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});

for (const source of ["local", "server"] as const)
  it(`${source} select-all operates only on keyword results, preserves selection order and leaves limits to submission`, async () => {
    const field = createField("multiselect", {
      options,
      selectionLimit: { enabled: true, max: 2 },
      defaultValue: ["c", "a"],
    });
    const value = ref<unknown>(["c", "a"]);
    await mount({
      render: () => {
        const props = {
          field,
          label: "部门",
          inputId: "department",
          modelValue: value.value,
          "onUpdate:modelValue": (next: unknown) => (value.value = next),
        };
        return source === "local"
          ? h(FieldControl, props)
          : h(ServerFieldControl, props);
      },
    });
    control("部门").click();
    await settle();
    expect(control("部门全选").indeterminate).toBe(true);
    expect(control("部门全选").getAttribute("aria-checked")).toBe("mixed");
    await search("  销售　 质量  ");
    expect(control("部门搜索选项").placeholder).toBe(
      "搜索（多个关键词用空格隔开）",
    );
    expect(control("部门 仓储部")).toBeNull();
    control("部门搜索结果全选").click();
    await settle();
    expect(value.value).toEqual(["c", "a", "b"]);
    expect(control("部门搜索结果全选").checked).toBe(true);
    expect(selectionCountMessage(field, value.value)).toBe("最多选择2项");
    expect(document.querySelector("summary")?.textContent).toContain(
      "仓储部、销售部、质量部",
    );
    control("部门搜索结果全选").click();
    await settle();
    expect(value.value).toEqual(["c"]);
    await search("　");
    control("部门全选").click();
    await settle();
    expect(value.value).toEqual(["c", "a", "b"]);
    expect(field.defaultValue).toEqual(["c", "a"]);
    expect(field.options).toEqual(options);
    control("部门全选").click();
    await settle();
    expect(value.value).toEqual([]);
  });

it("temporary additions participate in matching and select-all without changing the field definition", async () => {
  const field = createField("multiselect", {
    options,
    allowCustomChoices: true,
  });
  const value = ref<ChoiceValue[]>(["c", { text: "临时售后组" }]);
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field,
        label: "部门",
        modelValue: value.value,
        "onUpdate:modelValue": (next) => (value.value = next as ChoiceValue[]),
      }),
  });
  control("部门").click();
  await settle();
  control("部门 临时售后组").click();
  await settle();
  await search("临时 销售");
  control("部门搜索结果全选").click();
  await settle();
  expect(value.value).toEqual(["c", "a", { text: "临时售后组" }]);
  expect(control("部门搜索结果全选").checked).toBe(true);
  control("部门搜索结果全选").click();
  await settle();
  expect(value.value).toEqual(["c"]);
  expect(control("部门 临时售后组")).not.toBeNull();
  expect(field.options).toEqual(options);
});

it("dynamic candidate identities and repeated labels stay distinct; filtered toggles preserve values outside the candidates", async () => {
  const field = createField("multiselect", { options: [] });
  field.choiceSource.mode = "form";
  const candidates = ref([
    { id: "x", label: "同名部门" },
    { id: "y", label: "同名部门" },
    { id: "z", label: "Finance" },
  ]);
  const value = ref<ChoiceValue[]>(["unavailable", "y"]);
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field,
        choices: candidates.value,
        label: "部门",
        modelValue: value.value,
        "onUpdate:modelValue": (next) => (value.value = next as ChoiceValue[]),
      }),
  });
  control("部门").click();
  await settle();
  await search("同名 FINANCE");
  control("部门搜索结果全选").click();
  await settle();
  expect(value.value).toEqual(["unavailable", "y", "x", "z"]);
  candidates.value = [
    { id: "new", label: "新增" },
    { id: "z", label: "Finance" },
  ];
  await search("finance");
  expect(control("部门搜索结果全选").checked).toBe(true);
  control("部门搜索结果全选").click();
  await settle();
  expect(value.value).toEqual(["unavailable", "y", "x"]);
  await search("");
  expect(control("部门全选").indeterminate).toBe(false);
  control("部门全选").click();
  await settle();
  expect(value.value).toEqual(["unavailable", "y", "x", "new", "z"]);
});

it("empty results disable select-all; arrow navigation skips disabled controls and read-only closes without writes", async () => {
  const value = ref<ChoiceValue[]>(["a"]),
    disabled = ref(false);
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field: createField("multiselect", { options }),
        label: "部门",
        modelValue: value.value,
        disabled: disabled.value,
        "onUpdate:modelValue": (next) => (value.value = next as ChoiceValue[]),
      }),
  });
  control("部门").click();
  await settle();
  await search("找不到");
  const emptyAll = control("部门搜索结果全选");
  expect(emptyAll.disabled).toBe(true);
  emptyAll.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(value.value).toEqual(["a"]);
  expect(document.querySelector(".choice-popup-list")?.textContent).toContain(
    "没有匹配选项",
  );
  const input = control("部门搜索选项");
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(document.activeElement).toBe(input);
  await search("");
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(document.activeElement).toBe(control("部门全选"));
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(document.activeElement).toBe(control("部门 仓储部"));
  const all = control("部门全选");
  disabled.value = true;
  await settle();
  expect(document.querySelector(".choice-popup")).toBeNull();
  all.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(value.value).toEqual(["a"]);
  control("部门").click();
  await settle();
  expect(document.querySelector(".choice-popup")).toBeNull();
});

it("single dropdown keeps literal multiword matching and has no select-all control", async () => {
  const value = ref<unknown>("");
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field: createField("select", {
          options: [
            { id: "alpha", label: "North Sales" },
            { id: "beta", label: "Sales North" },
          ],
        }),
        label: "部门",
        modelValue: value.value,
        "onUpdate:modelValue": (next) => (value.value = next),
      }),
  });
  control("部门").click();
  await settle();
  await search("  NORTH SALES ");
  expect(control("部门全选")).toBeNull();
  expect(control("部门搜索选项").placeholder).toBe("搜索");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  document.querySelector<HTMLElement>('[role="option"]')!.click();
  await settle();
  expect(value.value).toBe("alpha");
  expect(document.querySelector(".choice-popup")).toBeNull();
});

it("keeps unavailable choices out of bulk selection while retaining their existing values", async () => {
  const field = createField("multiselect", { options });
  const value = ref<ChoiceValue[]>(["b"]);
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field,
        label: "部门",
        modelValue: value.value,
        disabledOptionIds: ["b"],
        "onUpdate:modelValue": (next) => (value.value = next as ChoiceValue[]),
      }),
  });
  control("部门").click();
  await settle();
  expect(control("部门 质量部").disabled).toBe(true);
  control("部门全选").click();
  await settle();
  expect(value.value).toEqual(["b", "a", "c"]);
  expect(control("部门全选").checked).toBe(true);
  control("部门全选").click();
  await settle();
  expect(value.value).toEqual(["b"]);
  expect(field.options).toEqual(options);
});
