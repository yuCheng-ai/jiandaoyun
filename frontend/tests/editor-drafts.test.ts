import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { createRenderer, defineComponent, h, nextTick, ref, watch } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  checkedDraftValue,
  contextFingerprint,
  parseEditorDrafts,
  serializeEditorDrafts,
  type EditorDraft,
} from "../src/domain/editorDrafts";
import {
  restoreProfileDraft,
  restoreRuntimeDraft,
  restoreWebhookDraft,
} from "../src/domain/editorDraftAdapters";
import { createField } from "../src/domain/form";
import { newWebhook } from "../src/domain/extensions";
import { seedWorkspace } from "../src/domain/workspace";
import {
  EditorDraftRepository,
  EDITOR_DRAFT_KEY,
} from "../src/repositories/editorDraftRepository";
import { WORKSPACE_KEY } from "../src/repositories/workspaceRepository";
import { useEditorDraftStore } from "../src/stores/editorDrafts";
import { useWorkspaceStore } from "../src/stores/workspace";
import { useEditorDraft } from "../src/composables/useEditorDraft";
import { useDraftDismiss } from "../src/composables/useDraftDismiss";

let memory: Map<string, string>;
let storage: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
};
const draft = (
  id = "one",
  value: unknown = { name: "Unsaved" },
): EditorDraft => ({
  id,
  key: "profile:zhang",
  title: "个人信息 · 张三",
  path: "/",
  context: "original-zhang",
  value,
  updatedAt: "2026-10-08T05:00:00.000Z",
});
beforeEach(() => {
  memory = new Map();
  storage = {
    getItem: vi.fn((key: string) => memory.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      memory.set(key, value);
    }),
  };
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.useRealTimers());

describe("editor draft files and explicit checkpoints", () => {
  it("treats reordered context properties as unchanged but still rejects changed values and array order", () => {
    const original = JSON.stringify({
      schema: { scope: { mode: "all" }, fields: ["a", "b"] },
      member: "zhang",
    });
    const reordered = JSON.stringify({
      member: "zhang",
      schema: { fields: ["a", "b"], scope: { mode: "all" } },
    });
    expect(contextFingerprint(original)).toBe(contextFingerprint(reordered));
    expect(contextFingerprint(original)).not.toBe(
      contextFingerprint(reordered.replace('"zhang"', '"li"')),
    );
    expect(contextFingerprint(original)).not.toBe(
      contextFingerprint(reordered.replace('["a","b"]', '["b","a"]')),
    );
    const store = useEditorDraftStore(createPinia());
    store.capture({ ...draft(), context: original });
    store.register({
      active: () => true,
      key: () => draft().key,
      context: () => reordered,
      value: () => ({}),
      restore: () => {},
    });
    expect(store.prepareRestore("one")).toBeDefined();
  });
  it("normalizes optional properties, clones values and rejects unsafe/deep/non-JSON contents", () => {
    const source = { optional: undefined, nested: [undefined, { n: 1 }] };
    const saved = checkedDraftValue(source);
    expect(saved).toEqual({ nested: [null, { n: 1 }] });
    source.nested.push({ n: 2 });
    expect(saved).toEqual({ nested: [null, { n: 1 }] });
    expect(() =>
      checkedDraftValue(JSON.parse('{"__proto__":{"bad":true}}')),
    ).toThrow("不允许");
    expect(() => checkedDraftValue({ number: NaN })).toThrow("无效");
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => checkedDraftValue(cycle)).toThrow("复杂");
    expect(() => checkedDraftValue("x".repeat(1_000_001))).toThrow("1 MB");
    expect(() => checkedDraftValue("字".repeat(340_000))).toThrow("1 MB");
  });
  it("reads standalone and workspace envelopes and rejects unsafe sources", () => {
    expect(parseEditorDrafts(serializeEditorDrafts([draft()]))).toEqual([
      draft(),
    ]);
    expect(
      parseEditorDrafts(
        JSON.stringify({
          format: "workflow-studio-recovery-v1",
          editorDrafts: [draft()],
        }),
      ),
    ).toEqual([draft()]);
    for (const path of [
      "https://example.com",
      "//example.com",
      "/\\example.com",
      "/\n",
    ]) {
      expect(() =>
        parseEditorDrafts(serializeEditorDrafts([{ ...draft(), path }])),
      ).toThrow("来源");
    }
    expect(() => parseEditorDrafts('{"format":"unknown","drafts":[]}')).toThrow(
      "有效",
    );
  });
  it("never replaces an unreadable checkpoint file", () => {
    memory.set(EDITOR_DRAFT_KEY, "damaged");
    const repository = new EditorDraftRepository(storage);
    expect(() => repository.load()).toThrow();
    expect(() => repository.save([draft()])).toThrow("不能覆盖");
    expect(memory.get(EDITOR_DRAFT_KEY)).toBe("damaged");
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("keeps editors usable when the browser denies storage access", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw Error("SecurityError");
      },
    });
    try {
      const store = useEditorDraftStore(createPinia());
      expect(store.error).toContain("未允许");
      store.capture(draft());
      expect(store.entries).toHaveLength(1);
      expect(store.checkpoint("one")).toBe(false);
      expect(parseEditorDrafts(store.exportDrafts())).toEqual([draft()]);
    } finally {
      vi.stubGlobal("sessionStorage", storage);
    }
  });
  it("keeps capture in memory until an explicit checkpoint, and later edits do not silently replace it", () => {
    const store = useEditorDraftStore(createPinia());
    store.capture(draft());
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.checkpoint("one")).toBe(true);
    expect(store.isCheckpoint(store.entries[0]!)).toBe(true);
    store.capture(draft("one", { name: "Later change" }));
    expect(store.isCheckpoint(store.entries[0]!)).toBe(false);
    expect(useEditorDraftStore(createPinia()).entries[0]!.value).toEqual({
      name: "Unsaved",
    });
    expect(store.entries[0]!.value).toEqual({ name: "Later change" });
  });
  it("retains both checkpoints and current edits if persistence fails", () => {
    const store = useEditorDraftStore(createPinia());
    store.capture(draft());
    store.checkpoint("one");
    const before = memory.get(EDITOR_DRAFT_KEY);
    store.capture(draft("one", { name: "Latest" }));
    storage.setItem.mockImplementation(() => {
      throw Error("quota");
    });
    expect(store.checkpoint("one")).toBe(false);
    expect(store.remove("one")).toBe(false);
    expect(memory.get(EDITOR_DRAFT_KEY)).toBe(before);
    expect(store.entries[0]!.value).toEqual({ name: "Latest" });
    expect(store.error).toBe("quota");
  });
  it("imports atomically, deduplicates and never persists or executes imported work", () => {
    const store = useEditorDraftStore(createPinia());
    store.capture(draft());
    const text = serializeEditorDrafts([
      draft(),
      draft("two", { name: "Imported" }),
    ]);
    expect(store.importDrafts(text)).toBe(1);
    expect(store.importDrafts(text)).toBe(0);
    const before = store.exportDrafts();
    expect(
      store.importDrafts(
        serializeEditorDrafts([
          draft("three"),
          { ...draft("four"), path: "//bad" },
        ]),
      ),
    ).toBeUndefined();
    expect(store.exportDrafts()).toBe(before);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("refuses a fifty-first draft while preserving existing edits", () => {
    const store = useEditorDraftStore(createPinia());
    for (let i = 0; i < 50; i++)
      store.capture(draft(String(i), { name: String(i) }));
    store.capture(draft("extra"));
    expect(store.entries).toHaveLength(50);
    expect(store.error).toContain("50");
    store.capture(draft("0", { name: "Updated" }));
    expect(store.entries[0]!.value).toEqual({ name: "Updated" });
  });
});

describe("guarded restoration", () => {
  it("requires an open editor with matching key and original context", () => {
    const store = useEditorDraftStore(createPinia()),
      restore = vi.fn();
    store.capture(draft());
    let open = false,
      key = "profile:li",
      context = "original-zhang";
    const unregister = store.register({
      active: () => open,
      key: () => key,
      context: () => context,
      value: () => ({}),
      restore,
    });
    expect(store.prepareRestore("one")).toBeUndefined();
    open = true;
    expect(store.prepareRestore("one")).toBeUndefined();
    key = "profile:zhang";
    context = "changed-schema-or-original";
    expect(store.availability(store.entries[0]!).message).toContain("已变化");
    expect(store.prepareRestore("one")).toBeUndefined();
    context = "original-zhang";
    const ticket = store.prepareRestore("one")!;
    unregister();
    expect(store.restore(ticket)).toBe(false);
    expect(restore).not.toHaveBeenCalled();
  });
  it("rejects changes during confirmation, and otherwise only applies inputs without saving", () => {
    const store = useEditorDraftStore(createPinia());
    let value = { name: "Current" };
    store.capture(draft());
    const restore = vi.fn((next) => {
      value = next;
    });
    store.register({
      active: () => true,
      key: () => "profile:zhang",
      context: () => "original-zhang",
      value: () => value,
      restore,
    });
    let ticket = store.prepareRestore("one")!;
    value = { name: "Edited after confirmation opened" };
    expect(store.restore(ticket)).toBe(false);
    ticket = store.prepareRestore("one")!;
    store.capture(draft("one", { name: "Draft changed meanwhile" }));
    expect(store.restore(ticket)).toBe(false);
    ticket = store.prepareRestore("one")!;
    expect(store.restore(ticket)).toBe(true);
    expect(value.name).toBe("Draft changed meanwhile");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("restricts profile restoration and strips secret material from webhook configuration", () => {
    expect(
      restoreProfileDraft({
        name: "张三",
        email: "",
        phone: "",
        roleIds: ["admin"],
        status: "active",
      }),
    ).toEqual({ name: "张三", email: "", phone: "" });
    expect(() => restoreProfileDraft({ name: 123 })).toThrow("格式");
    const webhook = newWebhook();
    expect(
      restoreWebhookDraft(
        { ...webhook, secret: "not-configuration" },
        webhook.id,
      ),
    ).not.toHaveProperty("secret");
    expect(() => restoreWebhookDraft(webhook, "different")).toThrow("不属于");
  });
  it("restores nested values while preserving readonly fields and rejecting foreign or malformed values", () => {
    const text = createField("text"),
      locked = createField("text", { editable: false }),
      child = createField("number"),
      row = createField("subform", { children: [child] }),
      file = createField("file");
    const fields = [text, locked, row, file],
      current = {
        [text.id]: "Now",
        [locked.id]: "Locked",
        [row.id]: [],
        [file.id]: [],
      };
    expect(
      restoreRuntimeDraft(
        {
          [text.id]: "Recovered",
          [locked.id]: "Forged",
          [row.id]: [{ [child.id]: 12 }],
        },
        fields,
        current,
      ),
    ).toEqual({
      ...current,
      [text.id]: "Recovered",
      [row.id]: [{ [child.id]: 12 }],
    });
    expect(() =>
      restoreRuntimeDraft({ foreign: "x" }, fields, current),
    ).toThrow("没有的字段");
    expect(() =>
      restoreRuntimeDraft({ [row.id]: [null] }, fields, current),
    ).toThrow();
    expect(() =>
      restoreRuntimeDraft({ [file.id]: [null] }, fields, current),
    ).toThrow();
    expect(() =>
      restoreRuntimeDraft(
        {
          [file.id]: [
            {
              name: "x",
              size: 1,
              type: "image/png",
              preview: "https://external.test/tracking",
            },
          ],
        },
        fields,
        current,
      ),
    ).toThrow();
    expect(current[text.id]).toBe("Now");
  });
  it("includes live registered edits in work backups without writing business data", () => {
    const local = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
    const write = vi.fn((key, value) => local.set(key, value));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: write,
    });
    const pinia = createPinia(),
      workspace = useWorkspaceStore(pinia),
      edits = useEditorDraftStore(pinia);
    edits.capture(draft());
    expect(JSON.parse(workspace.exportRecovery()).editorDrafts).toEqual([
      draft(),
    ]);
    expect(write).not.toHaveBeenCalled();
  });
});

// A minimal Vue host exercises real component watchers/lifecycle without browser storage internals.
const renderer = createRenderer<any, any>({
  insert: () => {},
  remove: () => {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText: () => {},
  setElementText: () => {},
  parentNode: () => null,
  nextSibling: () => null,
  patchProp: () => {},
});
describe("editor lifecycle", () => {
  it("captures only dirty open dialogs, clears on save/discard, and captures subsequent edits", async () => {
    const pinia = createPinia(),
      store = useEditorDraftStore(pinia),
      open = ref(false),
      value = ref({ name: "" });
    let controls!: ReturnType<typeof useDraftDismiss>;
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
    });
    await router.push("/editor");
    const app = renderer.createApp(
      defineComponent({
        setup() {
          controls = useDraftDismiss(
            () => open.value,
            () => value.value,
            () => {
              open.value = false;
            },
            {
              key: () => "dialog",
              title: () => "Dialog",
              context: () => "original",
              restore: (v) => {
                value.value = v as typeof value.value;
              },
            },
          );
          watch(open, (visible) => {
            if (visible) value.value = { name: "Initial" };
          });
          return () => h("div");
        },
      }),
    );
    app.use(pinia);
    app.use(router);
    app.mount({});
    open.value = true;
    await nextTick();
    expect(store.entries).toHaveLength(0);
    value.value.name = "Unsaved";
    await nextTick();
    expect(store.entries).toHaveLength(1);
    const beforeUnload = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([name]) => name === "beforeunload")![1] as (
      event: any,
    ) => void;
    const event = { preventDefault: vi.fn() };
    beforeUnload(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(store.isCheckpoint(store.entries[0]!)).toBe(true);
    event.preventDefault.mockClear();
    expect(store.checkpoint(store.entries[0]!.id)).toBe(true);
    beforeUnload(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    value.value.name = "Changed after checkpoint";
    await nextTick();
    beforeUnload(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useEditorDraftStore(createPinia()).entries[0]!.value).toEqual({
      name: "Changed after checkpoint",
    });
    controls.markSaved();
    await nextTick();
    expect(store.entries).toHaveLength(0);
    value.value.name = "Another edit";
    await nextTick();
    expect(store.entries[0]!.value).toEqual({ name: "Another edit" });
    controls.discard();
    await nextTick();
    expect(store.entries).toHaveLength(0);
    app.unmount();
    expect(window.removeEventListener).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );
  });
  it("retains the original source and context when navigation unmounts a dirty editor", async () => {
    const pinia = createPinia(),
      store = useEditorDraftStore(pinia),
      value = ref({ name: "Initial" }),
      context = ref("original");
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
    });
    await router.push("/source");
    const app = renderer.createApp(
      defineComponent({
        setup() {
          useEditorDraft(
            {
              key: () => "dialog",
              title: () => "Dialog",
              context: () => context.value,
              restore: () => {},
            },
            () => true,
            () => value.value,
            () => value.value.name !== "Initial",
          );
          return () => h("div");
        },
      }),
    );
    app.use(pinia);
    app.use(router);
    app.mount({});
    value.value.name = "Retained";
    await nextTick();
    context.value = "latest";
    await router.push("/destination");
    app.unmount();
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      path: "/source",
      context: JSON.stringify("original"),
      value: { name: "Retained" },
    });
    expect(store.availability(store.entries[0]!).ready).toBe(false);
    expect(useEditorDraftStore(createPinia()).entries[0]?.value).toEqual({
      name: "Retained",
    });
  });
});

async function mountAutoEditor(autoPersist = true) {
  const pinia = createPinia(),
    store = useEditorDraftStore(pinia);
  const value = ref({ name: "Initial" }),
    key = ref("profile:zhang"),
    context = ref("original");
  let controls!: ReturnType<typeof useEditorDraft>;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
  });
  await router.push("/profile");
  const app = renderer.createApp(
    defineComponent({
      setup() {
        controls = useEditorDraft(
          {
            key: () => key.value,
            autoPersist: () => autoPersist,
            title: () => "Profile",
            context: () => context.value,
            restore: (next) => {
              value.value = next as typeof value.value;
            },
          },
          () => true,
          () => value.value,
          () => value.value.name !== "Initial",
        );
        return () => h("div");
      },
    }),
  );
  app.use(pinia);
  app.use(router);
  app.mount({});
  return { store, value, key, context, controls, app };
}

describe("automatic contextual recovery", () => {
  it("honors a form's disabled automatic retention setting and still protects unsaved input", async () => {
    vi.useFakeTimers();
    const editor = await mountAutoEditor(false);
    editor.value.value.name = "Do not cache";
    await nextTick();
    await vi.runAllTimersAsync();
    const event = { preventDefault: vi.fn() };
    const beforeUnload = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([name]) => name === "beforeunload")![1] as (
      event: any,
    ) => void;
    beforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(editor.store.entries[0]?.value).toEqual({ name: "Do not cache" });
    editor.app.unmount();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("debounces typing, persists the latest input, and does not offer the live edit for recovery", async () => {
    vi.useFakeTimers();
    const editor = await mountAutoEditor();
    editor.value.value.name = "First";
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);
    editor.value.value.name = "Latest";
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(editor.store.recoverable(editor.key.value)).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(editor.controls.retained.value).toBe(true);
    const refreshed = useEditorDraftStore(createPinia());
    expect(refreshed.recoverable(editor.key.value)[0]?.value).toEqual({
      name: "Latest",
    });
    editor.value.value.name = "x".repeat(1_000_001);
    await nextTick();
    expect(editor.store.issues[editor.key.value]).toBeTruthy();
    editor.value.value.name = "Latest";
    await nextTick();
    await vi.runAllTimersAsync();
    expect(editor.store.issues[editor.key.value]).toBeUndefined();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    editor.app.unmount();
  });
  it("restores the prior copy in place and clears it after a successful business save", async () => {
    vi.useFakeTimers();
    const old = await mountAutoEditor();
    old.value.value.name = "Before refresh";
    await nextTick();
    old.app.unmount();
    const editor = await mountAutoEditor();
    const saved = editor.store.recoverable(editor.key.value)[0]!;
    editor.value.value.name = "New input";
    await nextTick();
    editor.controls.flush();
    expect(editor.store.entries).toHaveLength(2);
    expect(editor.store.restore(editor.store.prepareRestore(saved.id)!)).toBe(
      true,
    );
    await nextTick();
    expect(editor.value.value.name).toBe("Before refresh");
    expect(editor.store.entries.map((entry) => entry.id)).toEqual([saved.id]);
    expect(editor.store.recoverable(editor.key.value)).toEqual([]);
    editor.controls.clear();
    await vi.runAllTimersAsync();
    editor.app.unmount();
    expect(useEditorDraftStore(createPinia()).entries).toEqual([]);
  });
  it("cancels delayed writes on discard and starts a new copy only for another edit", async () => {
    vi.useFakeTimers();
    const editor = await mountAutoEditor();
    editor.value.value.name = "x".repeat(1_000_001);
    await nextTick();
    expect(editor.store.issues[editor.key.value]).toBeTruthy();
    editor.value.value.name = "Initial";
    await nextTick();
    expect(editor.store.issues[editor.key.value]).toBeUndefined();
    editor.value.value.name = "Discarded";
    await nextTick();
    editor.controls.clear();
    await vi.runAllTimersAsync();
    expect(storage.setItem).not.toHaveBeenCalled();
    editor.value.value.name = "New edit";
    await nextTick();
    await vi.runAllTimersAsync();
    expect(useEditorDraftStore(createPinia()).entries[0]?.value).toEqual({
      name: "New edit",
    });
    editor.app.unmount();
  });
  it("preserves the prior copy on quota failure, protects unload, and retries without a manual backup", async () => {
    vi.useFakeTimers();
    const editor = await mountAutoEditor();
    editor.value.value.name = "Retained";
    await nextTick();
    await vi.runAllTimersAsync();
    storage.setItem.mockImplementation(() => {
      throw Error("quota");
    });
    editor.value.value.name = "Latest";
    await nextTick();
    await vi.runAllTimersAsync();
    expect(editor.controls.retained.value).toBe(false);
    expect(editor.store.issues[editor.key.value]).toBe("quota");
    expect(useEditorDraftStore(createPinia()).entries[0]?.value).toEqual({
      name: "Retained",
    });
    const event = { preventDefault: vi.fn() };
    const beforeUnload = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([name]) => name === "beforeunload")![1] as (
      event: any,
    ) => void;
    beforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    storage.setItem.mockImplementation((key, value) => {
      memory.set(key, value);
    });
    editor.store.retryCapture(editor.key.value);
    expect(editor.controls.retained.value).toBe(true);
    expect(editor.store.issues[editor.key.value]).toBeUndefined();
    expect(useEditorDraftStore(createPinia()).entries[0]?.value).toEqual({
      name: "Latest",
    });
    editor.app.unmount();
  });
  it("flushes the old identity before switching keys and cannot restore it into another member", async () => {
    vi.useFakeTimers();
    const editor = await mountAutoEditor();
    editor.value.value.name = "Zhang input";
    await nextTick();
    editor.key.value = "profile:li";
    editor.context.value = "other member";
    editor.value.value.name = "Initial";
    await nextTick();
    const old = editor.store.entries[0]!;
    expect(old.key).toBe("profile:zhang");
    expect(editor.store.availability(old).ready).toBe(false);
    expect(editor.store.recoverable(editor.key.value)).toEqual([]);
    editor.value.value.name = "Li input";
    await nextTick();
    await vi.runAllTimersAsync();
    expect(
      useEditorDraftStore(createPinia()).entries.map((entry) => [
        entry.key,
        entry.value,
      ]),
    ).toEqual([
      ["profile:li", { name: "Li input" }],
      ["profile:zhang", { name: "Zhang input" }],
    ]);
    editor.app.unmount();
  });
  it("does not overwrite unreadable copies during automatic saving", async () => {
    vi.useFakeTimers();
    memory.set(EDITOR_DRAFT_KEY, "damaged");
    const editor = await mountAutoEditor();
    editor.value.value.name = "Still editable";
    await nextTick();
    await vi.runAllTimersAsync();
    expect(editor.store.loadError).toBeTruthy();
    expect(editor.controls.retained.value).toBe(false);
    expect(editor.store.entries[0]?.value).toEqual({ name: "Still editable" });
    expect(memory.get(EDITOR_DRAFT_KEY)).toBe("damaged");
    expect(storage.setItem).not.toHaveBeenCalled();
    editor.app.unmount();
  });
});
