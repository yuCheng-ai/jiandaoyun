import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderer, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import ReminderEditor from "../src/features/extensions/components/ReminderEditor.vue";
import ButtonEditor from "../src/features/extensions/components/ButtonEditor.vue";
import { newReminder } from "../src/domain/reminders";
import { newButton } from "../src/domain/buttons";
import { useWorkspaceStore } from "../src/stores/workspace";
import PluginEditor from "../src/features/extensions/components/PluginEditor.vue";
import { createField, emptySchema } from "../src/domain/form";
import { newInvocation, type PluginInvocation } from "../src/domain/extensions";
import { newAutomation, newAutomationStep } from "../src/domain/automation";
import {
  restoreReminderDraft,
  restoreButtonDraft,
  restoreAutomationDraft,
  restorePluginDraft,
} from "../src/domain/extensionDraftAdapters";
import { useEditorDraftStore } from "../src/stores/editorDrafts";

// Use the real editor and its event handlers, with a small Vue host instead of a browser DOM.
// Dialog layout and nested field widgets are independently exercised by browser QA.
vi.mock("../src/components/BaseDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: ["open", "busy", "draftKey"],
      setup:
        (props, { slots }) =>
        () =>
          props.open
            ? h("section", { "aria-busy": props.busy }, [
                slots.default?.(),
                slots.footer?.(),
              ])
            : null,
    }),
  };
});
vi.mock("../src/features/extensions/components/BindingEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: ["modelValue", "label"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit }) =>
        () =>
          h("input", {
            "aria-label": props.label,
            value: props.modelValue.value,
            onInput: (event: any) =>
              emit("update:modelValue", {
                ...props.modelValue,
                value: event.target.value,
              }),
          }),
    }),
  };
});
vi.mock("../src/features/extensions/components/SampleEditor.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/features/extensions/components/RunTrace.vue", () => ({
  default: { render: () => null },
}));

vi.mock("../src/components/organization/IdentityInput.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/features/forms/components/DataFilterEditor.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/features/forms/components/FieldControl.vue", () => ({
  default: { render: () => null },
}));

type Host = {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Host[];
  parent?: Host;
  addEventListener: () => void;
  removeEventListener: () => void;
  getRootNode: () => { activeElement: unknown };
  value?: unknown;
  readonly options?: Host[];
};
const node = (tag: string, text = ""): Host => ({
  tag,
  text,
  props: {},
  children: [],
  get options() {
    return this.children.filter((child) => child.tag === "option");
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  getRootNode: () => ({ activeElement: null }),
});
function detach(child: Host) {
  const parent = child.parent;
  if (parent) parent.children.splice(parent.children.indexOf(child), 1);
}
const renderer = createRenderer<Host, Host>({
  insert(child, parent, anchor) {
    detach(child);
    child.parent = parent;
    parent.children.splice(
      anchor ? parent.children.indexOf(anchor) : parent.children.length,
      0,
      child,
    );
  },
  remove: detach,
  createElement: (tag) => node(tag),
  createText: (text) => node("text", text),
  createComment: (text) => node("comment", text),
  setText: (el, text) => {
    el.text = text;
  },
  setElementText: (el, text) => {
    el.text = text;
    el.children = [];
  },
  parentNode: (el) => el.parent || null,
  nextSibling: (el) =>
    el.parent?.children[el.parent.children.indexOf(el) + 1] || null,
  patchProp: (el, key, _previous, value) => {
    el.props[key] = value;
    if (key === "value") {
      el.value = value;
      (el as any)._value = value;
    }
  },
  insertStaticContent: (content, parent, anchor) => {
    const el = node("static", content);
    el.parent = parent;
    parent.children.splice(
      anchor ? parent.children.indexOf(anchor) : parent.children.length,
      0,
      el,
    );
    return [el, el];
  },
});
const flatten = (root: Host): Host[] => [
  root,
  ...root.children.flatMap(flatten),
];
const text = (el: Host): string =>
  (el.tag === "comment" ? "" : el.text) + el.children.map(text).join("");
beforeEach(() => {
  vi.stubGlobal("Document", class {});
  vi.stubGlobal("ShadowRoot", class {});
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) || null,
    setItem: (key: string, value: string) => memory.set(key, value),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    activeElement: null,
    getElementById: () => null,
    querySelector: () => null,
  });
});
async function mountEditor(
  commit: (config: PluginInvocation) => boolean | Promise<boolean>,
) {
  const schema = emptySchema();
  schema.fields = [createField("number", { id: "amount", label: "金额" })];
  const config = newInvocation("multiply");
  config.inputs.quantity = { source: "constant", value: "2" };
  config.inputs.price = { source: "constant", value: "10" };
  config.outputs = [{ outputKey: "amount", fieldId: "amount" }];
  const close = vi.fn(),
    root = node("root"),
    pinia = createPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
  });
  await router.push("/plugin");
  const app = renderer.createApp(PluginEditor, {
    open: true,
    modelValue: config,
    schema,
    formId: "form",
    nodeId: "node",
    saveConfig: commit,
    onClose: close,
  });
  app.use(pinia);
  app.use(router);
  app.mount(root);
  await nextTick();
  const button = (label: string) => {
    const buttons = flatten(root).filter(
      (el) => el.tag === "button" && text(el).includes(label),
    );
    expect(buttons, `button containing ${label}`).toHaveLength(1);
    return buttons[0]!;
  };
  const input = (label: string) =>
    flatten(root).find(
      (el) => el.tag === "input" && el.props["aria-label"] === label,
    )!;
  const editQuantity = async () => {
    input("数量").props.onInput({ target: { value: "3" } });
    await nextTick();
  };
  const trialStep = async () => {
    button("试运行").props.onClick();
    await nextTick();
  };
  return {
    app,
    root,
    button,
    input,
    close,
    editQuantity,
    trialStep,
    drafts: useEditorDraftStore(pinia),
  };
}

describe("plugin save acknowledgement and editing", () => {
  it("waits for a real result, rejects duplicate save clicks, and retains edits on failure", async () => {
    let resolve!: (ok: boolean) => void;
    const commit = vi.fn(
      (_config: PluginInvocation) =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const editor = await mountEditor(commit);
    expect(editor.drafts.entries).toHaveLength(0);
    await editor.editQuantity();
    await editor.trialStep();
    const saving = editor.button("应用到节点").props.onClick();
    await nextTick();
    expect(editor.close).not.toHaveBeenCalled();
    expect(editor.drafts.entries).toHaveLength(1);
    expect(editor.root.children[0]?.props["aria-busy"]).toBe(true);
    await editor.button("正在保存").props.onClick();
    expect(commit).toHaveBeenCalledTimes(1);
    resolve(false);
    await saving;
    await nextTick();
    expect(text(editor.root)).toContain("配置已保留");
    expect(editor.close).not.toHaveBeenCalled();
    expect(
      (editor.drafts.entries[0]?.value as PluginInvocation).inputs.quantity
        ?.value,
    ).toBe("3");
    const retry = editor.button("应用到节点").props.onClick();
    resolve(true);
    await retry;
    await nextTick();
    expect(editor.close).toHaveBeenCalledOnce();
    expect(editor.drafts.entries).toHaveLength(0);
    expect(commit.mock.calls[0]?.[0].inputs.quantity?.value).toBe("3");
    editor.app.unmount();
  });
  it("keeps configuration editable when the parent save rejects", async () => {
    const editor = await mountEditor(async () => {
      throw Error("unavailable");
    });
    await editor.editQuantity();
    await editor.trialStep();
    await editor.button("应用到节点").props.onClick();
    await nextTick();
    expect(editor.close).not.toHaveBeenCalled();
    expect(editor.drafts.entries).toHaveLength(1);
    expect(text(editor.root)).toContain("保存失败");
    expect(editor.root.children[0]?.props["aria-busy"]).toBe(false);
    editor.app.unmount();
  });
  it("preserves parameters when reselecting the same action and confirms replacement", async () => {
    const editor = await mountEditor(() => true);
    await editor.editQuantity();
    editor.button("选择动作").props.onClick();
    await nextTick();
    editor.button("计算金额").props.onClick();
    await nextTick();
    expect(editor.input("数量").props.value).toBe("3");
    editor.button("选择动作").props.onClick();
    await nextTick();
    editor.button("组合文本并回填").props.onClick();
    await nextTick();
    expect(text(editor.root)).toContain("清空当前输入参数");
    expect((editor.drafts.entries[0]?.value as PluginInvocation).actionId).toBe(
      "multiply",
    );
    editor.button("保留当前动作").props.onClick();
    await nextTick();
    editor.button("组合文本并回填").props.onClick();
    await nextTick();
    editor.button("确认切换动作").props.onClick();
    await nextTick();
    expect(editor.input("文本内容").props.value).toBe("");
    expect(
      (editor.drafts.entries[0]?.value as PluginInvocation).outputs,
    ).toEqual([]);
    editor.app.unmount();
  });
});

describe("extension recovery adapters", () => {
  it("preserves plugin stable-ID inputs and outputs without accepting malformed bindings", () => {
    const config = newInvocation("update");
    config.inputs.text = { source: "template", value: "客户 {{customer-id}}" };
    config.outputs = [{ outputKey: "value", fieldId: "result-id" }];
    expect(
      restorePluginDraft({ ...config, result: { status: "success" } }),
    ).toEqual(config);
    expect(restorePluginDraft(newInvocation())).toEqual(newInvocation());
    expect(() =>
      restorePluginDraft({
        ...config,
        inputs: { text: { source: "remote", value: 1 } },
      }),
    ).toThrow("格式");
    expect(() => restorePluginDraft(JSON.parse('{"__proto__":{}}'))).toThrow(
      "属性",
    );
    expect(() =>
      restorePluginDraft({
        ...config,
        outputs: [{ outputKey: "value", fieldId: "constructor" }],
      }),
    ).toThrow("格式");
  });
  it("preserves incomplete automation steps, pinned versions and ordered mappings", () => {
    const config = newAutomation(),
      step = newAutomationStep();
    Object.assign(step, {
      action: "update",
      targetFormId: "customers",
      targetVersion: 2,
      onNoMatch: "fail",
      mappings: [
        {
          targetId: "target-id",
          source: "field",
          fieldId: "source-id",
          value: "",
        },
      ],
    });
    config.steps.push(step);
    expect(restoreAutomationDraft(config, config.id)).toEqual(config);
    expect(() => restoreAutomationDraft(config, "other")).toThrow("不属于");
    expect(() =>
      restoreAutomationDraft({ ...config, steps: Array(21).fill(step) }),
    ).toThrow("格式");
    expect(() =>
      restoreAutomationDraft({ ...config, steps: [step, step] }),
    ).toThrow("重复");
  });
});

async function mountBusinessEditor(kind: "reminder" | "button") {
  const schema = emptySchema();
  schema.fields = [createField("text", { id: "text", label: "内容" })];
  const config =
    kind === "reminder"
      ? {
          ...newReminder(),
          name: "提醒",
          title: "检查 {{text}}",
          message: "处理内容",
          recipients: {
            source: "fixed" as const,
            ids: ["member"],
            fieldId: "",
          },
        }
      : {
          ...newButton(),
          name: "处理",
          action: "link" as const,
          url: "https://example.com",
          params: [
            {
              name: "text",
              binding: { source: "field" as const, fieldId: "text", value: "" },
            },
          ],
        };
  const root = node("root"),
    pinia = createPinia(),
    close = vi.fn();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
  });
  await router.push(`/${kind}`);
  const app = renderer.createApp(
    kind === "reminder" ? ReminderEditor : ButtonEditor,
    { open: true, modelValue: config, schema, formId: "form", onClose: close },
  );
  app.use(pinia);
  app.use(router);
  app.mount(root);
  await nextTick();
  const button = (name: string) =>
    flatten(root).find(
      (el) => el.tag === "button" && text(el).trim() === name,
    )!;
  const edit = async () => {
    const input = flatten(root).find(
      (el) => el.tag === "input" && el.value === config.name,
    )!;
    input.props["onUpdate:modelValue"]("修改后的配置");
    await nextTick();
  };
  return {
    app,
    root,
    button,
    edit,
    close,
    config,
    store: useWorkspaceStore(pinia),
    drafts: useEditorDraftStore(pinia),
  };
}
for (const kind of ["reminder", "button"] as const) {
  describe(`${kind} editor dismissal and save`, () => {
    it("closes immediately when unchanged and confirms explicit discard when edited", async () => {
      const editor = await mountBusinessEditor(kind);
      editor.button("取消").props.onClick();
      expect(editor.close).toHaveBeenCalledOnce();
      editor.close.mockClear();
      await editor.edit();
      editor.button("取消").props.onClick();
      await nextTick();
      expect(editor.close).not.toHaveBeenCalled();
      expect(editor.button("放弃修改")).toBeDefined();
      editor.button("继续编辑").props.onClick();
      await nextTick();
      expect(editor.button("放弃修改")).toBeUndefined();
      editor.button("取消").props.onClick();
      await nextTick();
      editor.button("放弃修改").props.onClick();
      await nextTick();
      expect(editor.close).toHaveBeenCalledOnce();
      expect(editor.drafts.entries).toHaveLength(0);
      expect(editor.config.name).not.toBe("修改后的配置");
      editor.app.unmount();
    });
    it("retains inputs on rejected save and clears them only after successful retry", async () => {
      const editor = await mountBusinessEditor(kind);
      await editor.edit();
      for (let i = 0; i < (kind === "reminder" ? 3 : 2); i++) {
        editor.button("下一步").props.onClick();
        await nextTick();
      }
      const commit = vi.spyOn(
        editor.store,
        kind === "reminder" ? "saveReminder" : "saveButton",
      );
      commit.mockRejectedValueOnce(Error("unavailable"));
      const label = kind === "reminder" ? "保存提醒" : "保存按钮";
      await editor.button(label).props.onClick();
      await nextTick();
      expect(editor.close).not.toHaveBeenCalled();
      expect(text(editor.root)).toContain("配置已保留");
      expect(editor.drafts.entries).toHaveLength(1);
      commit.mockResolvedValueOnce(true);
      await editor.button(label).props.onClick();
      await nextTick();
      expect(editor.close).toHaveBeenCalledOnce();
      expect(editor.drafts.entries).toHaveLength(0);
      editor.app.unmount();
    });
  });
}
it("restores unfinished reminder dates and stable recipient/template references", () => {
  const config = {
    ...newReminder(),
    trigger: "date",
    dateFieldId: "due-id",
    offsetDays: "",
    time: "",
    recipients: { source: "field", ids: [], fieldId: "owner-id" },
    message: "{{name-id}}",
    filters: [
      {
        id: "filter",
        sourceFieldId: "",
        source: "constant",
        operator: "equals",
        value: "",
      },
    ],
  };
  expect(
    restoreReminderDraft({ ...config, result: "old result" }, config.id),
  ).toEqual(config);
  expect(() => restoreReminderDraft(config, "wrong")).toThrow("不属于");
  expect(() =>
    restoreReminderDraft({ ...config, recipients: { source: "remote" } }),
  ).toThrow("格式");
});
it("restores typed button constants and both link and form bindings without truncating", () => {
  const config = {
    ...newButton(),
    action: "openForm",
    targetFormId: "form-id",
    mappings: [
      { targetId: "field-id", source: "constant", fieldId: "", value: null },
    ],
    params: [
      {
        name: "",
        binding: { source: "field", fieldId: "source-id", value: [] },
      },
    ],
  };
  expect(
    restoreButtonDraft({ ...config, trial: "old result" }, config.id),
  ).toEqual(config);
  expect(() => restoreButtonDraft(config, "wrong")).toThrow("不属于");
  expect(() =>
    restoreButtonDraft({
      ...config,
      mappings: Array(101).fill(config.mappings[0]),
    }),
  ).toThrow("格式");
  expect(() =>
    restoreButtonDraft({
      ...config,
      filters: [
        {
          id: "bad",
          sourceFieldId: "",
          source: "remote",
          operator: "equals",
          value: "",
        },
      ],
    }),
  ).toThrow("筛选");
});
