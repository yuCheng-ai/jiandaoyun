// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import { createField } from "../src/domain/form";
vi.mock("../src/features/forms/components/FieldControl.vue", () => ({
  default: defineComponent({ render: () => null }),
}));
let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
async function mount(allowDuplicate?: boolean) {
  const text = createField("text", { id: "name" }),
    subform = createField("subform", {
      id: "items",
      children: [createField("number", { id: "quantity" })],
    });
  const duplicate = vi.fn();
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp({
    render: () =>
      h(FieldCanvas, {
        fields: [text, subform],
        selectedIds: ["name", "quantity"],
        ...(allowDuplicate === undefined ? {} : { allowDuplicate }),
        onDuplicate: duplicate,
      }),
  });
  app.mount("#mount");
  await nextTick();
  return duplicate;
}
it("ordinary form fields and subform columns expose copying by default and emit the selected stable ID", async () => {
  const copied = await mount();
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>('[aria-label="复制字段"]'),
  ];
  expect(buttons).toHaveLength(2);
  buttons[0]!.click();
  buttons[1]!.click();
  expect(copied.mock.calls).toEqual([["name"], ["quantity"]]);
});
it("explicitly disabling copying also disables it in nested canvases without hiding deletion", async () => {
  await mount(false);
  expect(document.querySelector('[aria-label="复制字段"]')).toBeNull();
  expect(document.querySelectorAll('[aria-label="删除字段"]')).toHaveLength(2);
});
