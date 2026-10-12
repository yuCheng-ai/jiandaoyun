// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, ref } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import PrintTemplateEditor from "../src/features/extensions/components/PrintTemplateEditor.vue";
import QuickFillSettings from "../src/features/extensions/components/QuickFillSettings.vue";
import { createField } from "../src/domain/form";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import { newPrintTemplate } from "../src/domain/presentation";
import { newQuickFill } from "../src/domain/quickFill";
import { useWorkspaceStore } from "../src/stores/workspace";
import { useEditorDraftStore } from "../src/stores/editorDrafts";
import {
  restorePrintTemplateDraft,
  restoreQuickFillDraft,
} from "../src/domain/extensionDraftAdapters";

vi.mock("../src/stores/workspace", () => ({ useWorkspaceStore: vi.fn() }));
vi.mock("../src/features/forms/components/PrintDocument.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/features/forms/components/QuickFillDialog.vue", () => ({
  default: { render: () => null },
}));

const disposers = new Set<() => void>();
let store: ReturnType<typeof makeStore>;
function makeStore() {
  return reactive({
    data: seedWorkspace(),
    writePending: false,
    storageError: "",
    notify: vi.fn(),
    savePrintTemplate: vi.fn(),
    saveQuickFill: vi.fn(),
  });
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  store = makeStore();
  vi.mocked(useWorkspaceStore).mockReturnValue(store as any);
});
afterEach(() => {
  [...disposers].forEach((fn) => fn());
  vi.restoreAllMocks();
});
const cases = [
  {
    kind: "print",
    label: "模板名称",
    save: "保存模板",
    commit: "savePrintTemplate",
  },
  {
    kind: "quick",
    label: "填报示例",
    save: "保存快捷填报",
    commit: "saveQuickFill",
  },
] as const;
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  )!;
const input = (label: string) =>
  [...document.querySelectorAll("label")]
    .find((el) => el.textContent?.trim() === label)!
    .querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
async function edit(label: string, value: string) {
  input(label).value = value;
  input(label).dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}
async function click(name: string) {
  const el = button(name);
  expect(el, `button ${name}`).toBeDefined();
  el.click();
  await nextTick();
}
async function mount(kind: (typeof cases)[number]["kind"]) {
  const pinia = createPinia(),
    open = ref(true),
    close = vi.fn(() => {
      open.value = false;
    });
  const form = newForm("oa", "配置恢复"),
    schema = form.schema;
  form.id = "recovery-form";
  schema.fields = [createField("text", { id: "name", label: "名称" })];
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:all(.*)", component: { render: () => null } }],
  });
  await router.push("/extensions");
  const app = createApp({
    render: () => {
      if (kind === "print")
        return h(PrintTemplateEditor, {
          open: open.value,
          formId: form.id,
          schema,
          title: form.title,
          onClose: close,
        });
      return h(QuickFillSettings, { form });
    },
  });
  app.use(pinia).use(router).mount(document.getElementById("app")!);
  const unmount = () => {
    app.unmount();
    disposers.delete(unmount);
  };
  disposers.add(unmount);
  await nextTick();
  if (kind === "quick") await click("配置快捷填报");
  return { drafts: useEditorDraftStore(pinia), unmount, close, schema };
}
describe.each(cases)(
  "$kind configuration recovery",
  ({ kind, label, save, commit }) => {
    it("restores after an editor reload, retains failed saves and clears only after acknowledged retry", async () => {
      const first = await mount(kind);
      expect(first.drafts.entries).toHaveLength(0);
      await edit(label, "尚未保存的修改");
      expect(first.drafts.entries).toHaveLength(1);
      first.unmount(); // Real composable flushes to its repository on teardown.
      const second = await mount(kind);
      expect(input(label).value).not.toBe("尚未保存的修改");
      await click("恢复内容");
      await click("确认恢复");
      expect(input(label).value).toBe("尚未保存的修改");
      const pending = store[commit];
      pending.mockRejectedValueOnce(Error("offline"));
      await click(save);
      await vi.waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "已保留",
        ),
      );
      expect(second.drafts.entries).toHaveLength(1);
      expect(input(label).value).toBe("尚未保存的修改");
      pending.mockResolvedValueOnce(true);
      await click(save);
      await vi.waitFor(() =>
        expect(document.querySelector("dialog")).toBeNull(),
      );
      expect(second.drafts.entries).toHaveLength(0);
      second.unmount();
      const third = await mount(kind);
      expect(third.drafts.entries).toHaveLength(0);
    });
    it("rejects duplicate save clicks while pending and preserves a false save result for explicit discard", async () => {
      const editor = await mount(kind);
      await edit(label, "需要保留的修改");
      let finish!: (value: boolean) => void;
      store[commit].mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      );
      await click(save);
      await click(save);
      expect(store[commit]).toHaveBeenCalledOnce();
      expect(document.querySelector("dialog")?.getAttribute("aria-busy")).toBe(
        "true",
      );
      finish(false);
      await vi.waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "已保留",
        ),
      );
      await click("取消");
      await click("继续编辑");
      expect(input(label).value).toBe("需要保留的修改");
      await click("取消");
      await click("放弃修改");
      expect(document.querySelector("dialog")).toBeNull();
      expect(editor.drafts.entries).toHaveLength(0);
    });
    it("does not recover configuration under a different current member", async () => {
      const editor = await mount(kind);
      await edit(label, "原成员的修改");
      editor.unmount();
      store.data.organization.currentUserId = "another-member";
      await mount(kind);
      expect(button("恢复内容").disabled).toBe(true);
      expect(input(label).value).not.toBe("原成员的修改");
    });
  },
);

it("restores template order and identity, and refuses incompatible templates", () => {
  const template = newPrintTemplate(newForm("oa", "测试").schema, "采购");
  template.fieldIds = ["second", "first"];
  expect(restorePrintTemplateDraft(template, template.id)).toEqual(template);
  expect(() => restorePrintTemplateDraft(template, "other")).toThrow("不属于");
  expect(() =>
    restorePrintTemplateDraft({ ...template, fieldIds: ["a", "a"] }),
  ).toThrow("格式");
});
it("retains raw alias input and field binding without treating old preview results as configuration", () => {
  const value = {
    config: {
      ...newQuickFill(),
      fields: [{ fieldId: "name", aliases: ["名称"], instruction: "" }],
    },
    aliasText: { name: "名称， " },
  };
  expect(restoreQuickFillDraft({ ...value, preview: "old result" })).toEqual(
    value,
  );
  expect(() =>
    restoreQuickFillDraft({ ...value, aliasText: { name: 3 } }),
  ).toThrow("格式");
  expect(() => restoreQuickFillDraft(JSON.parse('{"__proto__":{}}'))).toThrow(
    "属性",
  );
});
it("restores unfinished print file names and rejects malformed naming shapes without silently changing the draft", () => {
  const form = newForm("oa", "名称恢复"),
    config = newPrintTemplate(form.schema, form.title);
  config.fileName = { mode: "custom", value: "尚未完成/{{name}" };
  expect(restorePrintTemplateDraft(config, config.id).fileName).toEqual(
    config.fileName,
  );
  for (const fileName of [
    null,
    { mode: "other", value: "a" },
    { mode: "custom", value: 1 },
  ])
    expect(() => restorePrintTemplateDraft({ ...config, fileName })).toThrow(
      "格式",
    );
  delete config.fileName;
  expect(restorePrintTemplateDraft(config).fileName).toBeUndefined();
});
