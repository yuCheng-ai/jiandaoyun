import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderer, defineComponent, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
import { createField, emptySchema, type FormSchema } from "../src/domain/form";
import { useEditorDraftStore } from "../src/stores/editorDrafts";
import { useWorkspaceStore } from "../src/stores/workspace";
import { EDITOR_DRAFT_KEY } from "../src/repositories/editorDraftRepository";

vi.mock("../src/features/forms/components/FormFields.vue", () => ({
  default: defineComponent({
    props: ["fields", "values", "disabled"],
    emits: ["change"],
    setup:
      (p, { emit }) =>
      () =>
        h(
          "section",
          p.fields.map((f: any) =>
            h("input", {
              name: f.id,
              value: p.values[f.id],
              disabled: p.disabled || !f.editable,
              onInput: (e: any) => emit("change", f.id, e.target.value),
            }),
          ),
        ),
  }),
}));
vi.mock("../src/components/shared/CustomButtonBar.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/features/forms/components/QuickFillDialog.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/components/shared/EditorDraftNotice.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/components/AppIcon.vue", () => ({
  default: { render: () => null },
}));

type Host = {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Host[];
  parent?: Host;
};
const node = (tag: string, text = ""): Host => ({
  tag,
  text,
  props: {},
  children: [],
});
function detach(n: Host) {
  if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
}
const renderer = createRenderer<Host, Host>({
  insert(n, p, anchor) {
    detach(n);
    n.parent = p;
    p.children.splice(
      anchor ? p.children.indexOf(anchor) : p.children.length,
      0,
      n,
    );
  },
  remove: detach,
  createElement: node,
  createText: (t) => node("text", t),
  createComment: (t) => node("comment", t),
  setText: (n, t) => {
    n.text = t;
  },
  setElementText: (n, t) => {
    n.text = t;
    n.children = [];
  },
  parentNode: (n) => n.parent || null,
  nextSibling: (n) =>
    n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
  patchProp: (n, k, _, v) => {
    n.props[k] = v;
  },
  insertStaticContent: (text, p) => {
    const n = node("static", text);
    p.children.push(n);
    n.parent = p;
    return [n, n];
  },
});
const flatten = (n: Host): Host[] => [n, ...n.children.flatMap(flatten)];
const content = (n: Host): string =>
  (n.tag === "comment" ? "" : n.text) + n.children.map(content).join("");
let memory: Map<string, string>;
beforeEach(() => {
  memory = new Map();
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
  };
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.useRealTimers());
async function mount(
  options: {
    preview?: boolean;
    cache?: boolean;
    legacy?: unknown;
    persist?: (v: any, d: boolean) => boolean | Promise<boolean>;
    settings?: Partial<FormSchema["settings"]>;
    readonly?: boolean;
  } = {},
) {
  const schema = emptySchema();
  schema.settings.cacheDraft = options.cache !== false;
  Object.assign(schema.settings, options.settings);
  schema.fields = [
    createField("text", { id: "name" }),
    createField("text", {
      id: "locked",
      editable: false,
      defaultValue: "Current",
    }),
  ];
  const pinia = createPinia(),
    workspace = useWorkspaceStore(pinia),
    drafts = useEditorDraftStore(pinia);
  const key = `form-fill-test-new-1-${workspace.data.organization.currentUserId}`;
  if (options.legacy) memory.set(key, JSON.stringify(options.legacy));
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
  });
  await router.push("/fill");
  const root = node("root"),
    onDraft = vi.fn(),
    onSubmit = vi.fn(),
    onContinue = vi.fn();
  const app = renderer.createApp(FormRuntime, {
    schema,
    formId: "test",
    cacheKey: "1",
    preview: !!options.preview,
    readonly: !!options.readonly,
    persistValues: options.persist,
    onDraft,
    onSubmit,
    onContinue,
  });
  app.use(pinia);
  app.use(router);
  app.mount(root);
  await nextTick();
  const input = (name = "name") =>
    flatten(root).find((n) => n.tag === "input" && n.props.name === name)!;
  const button = (name: string) =>
    flatten(root).find(
      (n) => n.tag === "button" && content(n).trim() === name,
    )!;
  const change = async (value: string) => {
    input().props.onInput({ target: { value } });
    await nextTick();
  };
  const submit = () =>
    flatten(root)
      .find((n) => n.tag === "form")!
      .props.onSubmit({ preventDefault() {} });
  return {
    app,
    key,
    root,
    drafts,
    input,
    button,
    change,
    submit,
    onDraft,
    onSubmit,
    onContinue,
  };
}
describe("formal filling and recovery", () => {
  it("a closed submit button blocks form submission while draft saving remains available", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const f = await mount({
      persist,
      settings: { allowSubmit: false, draftLabel: "暂存" },
    });
    expect(f.button("提交")).toBeUndefined();
    await f.change("Unsubmitted input");
    await f.submit();
    expect(persist).not.toHaveBeenCalled();
    expect(f.onSubmit).not.toHaveBeenCalled();
    await f.button("暂存").props.onClick();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Unsubmitted input" }),
      true,
    );
    expect(f.onDraft).toHaveBeenCalledOnce();
    f.app.unmount();
  });
  it("legacy settings retain submission and readonly views cannot submit through a form event", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const legacy = await mount({
      persist,
      settings: {
        allowSubmit: undefined,
        draftLabel: undefined,
        allowDraft: false,
        submitLabel: "确认登记",
      },
    });
    expect(legacy.button("确认登记")).toBeDefined();
    expect(legacy.button("保存草稿")).toBeUndefined();
    await legacy.change("Legacy input");
    await legacy.submit();
    expect(persist).toHaveBeenCalledOnce();
    legacy.app.unmount();
    persist.mockClear();
    const readonly = await mount({ persist, readonly: true });
    await readonly.submit();
    expect(persist).not.toHaveBeenCalled();
    readonly.app.unmount();
  });
  it("offers legacy content for explicit recovery without overwriting readonly fields", async () => {
    const f = await mount({ legacy: { name: "Old input", locked: "Stale" } });
    expect(f.input().props.value).toBe("");
    expect(memory.has(f.key)).toBe(false);
    const saved = f.drafts.recoverable(f.key)[0]!;
    expect(saved.value).toEqual({ name: "Old input", locked: "Current" });
    expect(f.drafts.isCheckpoint(saved)).toBe(true);
    expect(f.drafts.restore(f.drafts.prepareRestore(saved.id)!)).toBe(true);
    await nextTick();
    expect(f.input().props.value).toBe("Old input");
    expect(f.input("locked").props.value).toBe("Current");
    f.app.unmount();
  });
  it("writes only the shared recovery entry, while preview and cache-off never persist input", async () => {
    vi.useFakeTimers();
    const f = await mount();
    await f.change("Auto retained");
    await vi.advanceTimersByTimeAsync(400);
    expect(memory.has(EDITOR_DRAFT_KEY)).toBe(true);
    expect(memory.has(f.key)).toBe(false);
    f.app.unmount();
    memory.clear();
    for (const options of [{ preview: true }, { cache: false }]) {
      const other = await mount(options);
      await other.change("Transient");
      await vi.advanceTimersByTimeAsync(400);
      if (options.preview) await other.button("保存草稿").props.onClick();
      other.app.unmount();
      expect(memory.has(EDITOR_DRAFT_KEY)).toBe(false);
      expect(memory.has(other.key)).toBe(false);
    }
  });
  it("keeps failed saves recoverable and clears them before announcing a successful draft save", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const f = await mount({ persist });
    await f.change("Keep me");
    await f.button("保存草稿").props.onClick();
    await nextTick();
    expect(f.onDraft).not.toHaveBeenCalled();
    expect(f.input().props.value).toBe("Keep me");
    f.onDraft.mockImplementation(() =>
      expect(f.drafts.entries).toHaveLength(0),
    );
    await f.button("保存草稿").props.onClick();
    await nextTick();
    expect(f.onDraft).toHaveBeenCalledOnce();
    expect(memory.has(f.key)).toBe(false);
    f.app.unmount();
  });
  it("does not announce submission without persistence, and successful continuation starts empty", async () => {
    const missing = await mount();
    await missing.change("Not saved");
    await missing.submit();
    await nextTick();
    expect(missing.onSubmit).not.toHaveBeenCalled();
    expect(content(missing.root)).toContain("保存失败");
    missing.app.unmount();
    memory.clear();
    const persist = vi.fn().mockResolvedValue(true),
      f = await mount({ persist });
    await f.change("One record");
    await f.submit();
    await nextTick();
    expect(f.onSubmit).toHaveBeenCalledOnce();
    expect(f.drafts.entries).toHaveLength(0);
    await f.button("继续填写").props.onClick();
    await nextTick();
    expect(f.onContinue).toHaveBeenCalledOnce();
    expect(f.input().props.value).toBe("");
    expect(persist).toHaveBeenCalledOnce();
    f.app.unmount();
  });
});
