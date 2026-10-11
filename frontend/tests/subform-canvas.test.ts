// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import { createField, type FormField } from "../src/domain/form";

vi.mock("../src/features/forms/components/FieldControl.vue", () => ({
  default: defineComponent({ render: () => h("input", { disabled: true }) }),
}));
let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
async function mount(fields: FormField[], selectedIds: string[] = []) {
  const events = { select: vi.fn(), context: vi.fn(), drop: vi.fn() };
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp({
    render: () =>
      h(FieldCanvas, {
        fields,
        selectedIds,
        onSelect: events.select,
        onContext: events.context,
        onDrop: events.drop,
      }),
  });
  app.mount("#mount");
  await nextTick();
  return events;
}
function drag(
  target: Element,
  type: string,
  clientX: number,
  clientY: number,
  payload = '{"id":"moving"}',
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: { getData: () => payload },
  });
  target.dispatchEvent(event);
  return event;
}
it("accepts entry at each canvas drop surface without waiting for another drag-over", async () => {
  const events = await mount([
    createField("text", { id: "main" }),
    createField("subform", {
      id: "rows",
      children: [createField("text", { id: "code" })],
    }),
    createField("subform", { id: "empty" }),
  ]);
  const column = document.querySelector<HTMLElement>('[data-field-id="code"]')!;
  vi.spyOn(column, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 10,
    width: 200,
    height: 90,
  } as DOMRect);
  for (const target of [
    column,
    document.querySelector('[data-field-id="rows"] .field-drop-zone')!,
    document.querySelector('[data-field-id="rows"] .last-drop-zone')!,
    document.querySelector('[data-field-id="empty"] .last-drop-zone')!,
    document.querySelector('[data-field-id="main"]')!,
  ]) {
    expect(drag(target, "dragenter", 150, 40).defaultPrevented).toBe(true);
  }
  await nextTick();
  expect(
    document.querySelector('[data-field-id="empty"] .last-drop-zone.over'),
  ).not.toBeNull();
  expect(events.drop).not.toHaveBeenCalled();
  drag(column, "drop", 150, 40);
  expect(events.drop).toHaveBeenCalledOnce();
  expect(events.drop).toHaveBeenCalledWith({
    id: "moving",
    parentId: "rows",
    index: 0,
    tabId: undefined,
  });
});
it("renders one numbered preview row with horizontal subfields while main fields and tabs retain their layout", async () => {
  const rows = createField("subform", {
    id: "rows",
    children: [
      createField("text", { id: "code" }),
      createField("number", { id: "qty" }),
    ],
  });
  const tabs = createField("tabs", {
    id: "tabs",
    children: [createField("text", { id: "tab-text" })],
  });
  await mount([createField("text", { id: "main" }), rows, tabs]);
  const columns = document.querySelector(
    '[data-field-id="rows"] .subform-columns',
  )!;
  expect(columns).not.toBeNull();
  expect(columns.querySelector(".subform-design-row-number")?.textContent).toBe(
    "1",
  );
  expect(
    [...columns.querySelectorAll("[data-field-id]")].map((el) =>
      el.getAttribute("data-field-id"),
    ),
  ).toEqual(["code", "qty"]);
  expect(document.querySelector(".subform-design-heading")).toBeNull();
  expect(
    document.querySelector('[data-field-id="tabs"] .subform-columns'),
  ).toBeNull();
  expect(
    document
      .querySelector('[data-field-id="main"]')
      ?.closest(".subform-columns"),
  ).toBeNull();
});
it("selecting a column keeps its parent insertion context and selecting the table keeps the parent field", async () => {
  const events = await mount([
    createField("subform", {
      id: "rows",
      children: [createField("text", { id: "code" })],
    }),
  ]);
  document
    .querySelector<HTMLElement>('[data-field-id="code"] > .field-design-label')!
    .click();
  expect(events.select.mock.calls.at(-1)?.[0]).toBe("code");
  expect(events.context).toHaveBeenLastCalledWith("rows", undefined);
  document.querySelector<HTMLElement>(".subform-design-row-number")!.click();
  expect(events.select.mock.calls.at(-1)?.[0]).toBe("rows");
  expect(events.context).toHaveBeenLastCalledWith("rows");
});
it("inserts before or after a subfield using the horizontal midpoint, preserving drop identity and parent", async () => {
  const events = await mount([
    createField("subform", {
      id: "rows",
      children: [createField("text", { id: "code" })],
    }),
  ]);
  const column = document.querySelector<HTMLElement>('[data-field-id="code"]')!;
  vi.spyOn(column, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 10,
    width: 200,
    height: 90,
  } as DOMRect);
  drag(column, "drop", 150, 89);
  drag(column, "drop", 250, 11);
  expect(events.drop.mock.calls.map((call) => call[0])).toEqual([
    { id: "moving", parentId: "rows", index: 0, tabId: undefined },
    { id: "moving", parentId: "rows", index: 1, tabId: undefined },
  ]);
});
it("main-field insertion continues using the vertical midpoint", async () => {
  const events = await mount([createField("text", { id: "main" })]);
  const card = document.querySelector<HTMLElement>('[data-field-id="main"]')!;
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 10,
    width: 200,
    height: 90,
  } as DOMRect);
  drag(card, "drop", 250, 20);
  drag(card, "drop", 150, 89);
  expect(events.drop.mock.calls.map((call) => call[0].index)).toEqual([0, 1]);
});
it("empty and trailing subform drop targets add to the same parent and ignore unrelated data", async () => {
  const events = await mount([
    createField("subform", { id: "empty" }),
    createField("subform", {
      id: "rows",
      children: [createField("text", { id: "code" })],
    }),
  ]);
  const empty = document.querySelector(
    '[data-field-id="empty"] .last-drop-zone',
  )!;
  const end = document.querySelector('[data-field-id="rows"] .last-drop-zone')!;
  drag(empty, "drop", 0, 0, '{"type":"number"}');
  drag(end, "drop", 0, 0);
  drag(end, "drop", 0, 0, "not a field");
  expect(events.drop.mock.calls.map((call) => call[0])).toEqual([
    { type: "number", parentId: "empty", index: 0, tabId: undefined },
    { id: "moving", parentId: "rows", index: 1, tabId: undefined },
  ]);
  expect(empty.textContent).toContain("拖入字段");
  expect(
    empty.parentElement?.querySelector(".subform-design-row-number"),
  ).toBeNull();
});
