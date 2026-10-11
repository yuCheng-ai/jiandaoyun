// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import BaseDialog from "../src/components/BaseDialog.vue";
import { useDraftDismiss } from "../src/composables/useDraftDismiss";
import { useWorkspaceStore } from "../src/stores/workspace";

vi.mock("../src/stores/workspace", async () => {
  const { reactive } = await import("vue");
  const state = reactive({ writePending: false });
  return { useWorkspaceStore: () => state };
});
vi.mock("../src/components/AppIcon.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/components/WorkspaceStorageNotice.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../src/components/shared/EditorDraftNotice.vue", () => ({
  default: { render: () => null },
}));

const cleanups: (() => void)[] = [];
beforeEach(() => {
  useWorkspaceStore().writePending = false;
  document.body.innerHTML =
    '<div id="app"><button id="opener">打开</button><div id="mount"></div></div>';
  document.body.style.overflow = "auto";
  // jsdom has no layout or inert reflection. Model only those browser facilities;
  // Vue rendering, Teleport, DOM events, focus and the dialog stack stay real.
  Object.defineProperty(HTMLElement.prototype, "inert", {
    configurable: true,
    get() {
      return this.hasAttribute("inert");
    },
    set(value) {
      this.toggleAttribute("inert", !!value);
    },
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return (this.isConnected && !this.hidden
        ? [{}]
        : []) as unknown as DOMRectList;
    },
  );
  document.querySelector<HTMLButtonElement>("#opener")!.focus();
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function mount(component: Parameters<typeof createApp>[0]) {
  const app = createApp(component);
  app.mount(document.querySelector("#mount")!);
  cleanups.push(() => app.unmount());
  return app;
}
function dialog(title = "编辑配置") {
  return document.querySelector<HTMLDialogElement>(
    `dialog[aria-label="${title}"]`,
  )!;
}
async function click(button: HTMLElement) {
  button.focus();
  button.click();
  await nextTick();
}
function escape() {
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("real shared dialog lifecycle", () => {
  it("does not lock an unrelated dialog while workspace saving is pending", async () => {
    const close = vi.fn();
    useWorkspaceStore().writePending = true;
    mount({
      render: () =>
        h(BaseDialog, { open: true, title: "编辑配置", onClose: close }),
    });
    await nextTick();
    expect(dialog().querySelector('[role="status"]')).toBeNull();
    await click(dialog().querySelector("button")!);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["header", "cancel", "backdrop", "escape"])(
    "closes through %s and can reopen without a stale overlay",
    async (method) => {
      const open = ref(true),
        closed = vi.fn();
      const close = () => {
        open.value = false;
      };
      mount({
        render: () =>
          h(
            BaseDialog,
            {
              open: open.value,
              title: "编辑配置",
              onClose: close,
              onClosed: closed,
            },
            {
              default: () => h("input", { value: "尚未保存" }),
              footer: () => h("button", { onClick: close }, "取消"),
            },
          ),
      });
      await nextTick();
      if (method === "escape") {
        escape();
        await nextTick();
      } else
        await click(
          document.querySelector<HTMLElement>(
            method === "header"
              ? ".dialog-header button"
              : method === "cancel"
                ? ".dialog-footer button"
                : ".dialog-layer",
          )!,
        );
      expect(document.querySelector(".dialog-layer")).toBeNull();
      expect(document.querySelector("#app")!.hasAttribute("inert")).toBe(false);
      expect(document.body.style.overflow).toBe("auto");
      expect(document.activeElement?.id).toBe("opener");
      expect(closed).toHaveBeenCalledOnce();
      open.value = true;
      await nextTick();
      expect(dialog().inert).toBe(false);
      await click(dialog().querySelector("button")!);
      expect(document.querySelector("dialog")).toBeNull();
      expect(closed).toHaveBeenCalledTimes(2);
    },
  );

  it("closes only the child, restores its parent, then removes all layers", async () => {
    const outer = ref(true),
      inner = ref(false);
    mount({
      render: () =>
        h(
          BaseDialog,
          {
            open: outer.value,
            title: "外层",
            onClose: () => {
              outer.value = false;
            },
          },
          {
            default: () => [
              h(
                "button",
                {
                  id: "picker",
                  onClick: () => {
                    inner.value = true;
                  },
                },
                "选择人员",
              ),
              h(BaseDialog, {
                open: inner.value,
                title: "人员",
                onClose: () => {
                  inner.value = false;
                },
              }),
            ],
          },
        ),
    });
    await nextTick();
    await click(document.querySelector("#picker")!);
    expect(dialog("外层").inert).toBe(true);
    escape();
    await nextTick();
    expect(dialog("人员")).toBeNull();
    expect(dialog("外层").inert).toBe(false);
    expect(document.activeElement?.id).toBe("picker");
    await click(dialog("外层").querySelector("button")!);
    expect(document.querySelectorAll(".dialog-layer")).toHaveLength(0);
    expect(document.activeElement?.id).toBe("opener");
  });

  it("shows a save state and restores close after the pending save ends", async () => {
    const busy = ref(false);
    const open = ref(true),
      close = vi.fn(() => {
        open.value = false;
      });
    mount({
      render: () =>
        h(BaseDialog, {
          open: open.value,
          title: "编辑配置",
          busy: busy.value,
          onClose: close,
        }),
    });
    await nextTick();
    busy.value = true;
    await nextTick();
    expect(dialog().querySelector("button")!.disabled).toBe(true);
    expect(dialog().querySelector('[role="status"]')!.textContent).toContain(
      "正在保存",
    );
    escape();
    await nextTick();
    expect(close).not.toHaveBeenCalled();
    busy.value = false;
    await nextTick();
    await click(dialog().querySelector("button")!);
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector(".dialog-layer")).toBeNull();
  });

  it("focuses the active child's discard decision even when its parent also has one", async () => {
    const childOpen = ref(false),
      changed = ref("original");
    const Child = defineComponent({
      setup() {
        const { requestClose, confirmDiscard, discard } = useDraftDismiss(
          () => childOpen.value,
          () => changed.value,
          () => {
            childOpen.value = false;
          },
        );
        return () =>
          h(
            BaseDialog,
            { open: childOpen.value, title: "子配置", onClose: requestClose },
            {
              default: () =>
                confirmDiscard.value
                  ? h("section", { class: "config-discard", tabindex: -1 }, [
                      h(
                        "button",
                        {
                          onClick: () => {
                            confirmDiscard.value = false;
                          },
                        },
                        "继续编辑",
                      ),
                      h(
                        "button",
                        { id: "discard", onClick: discard },
                        "放弃修改",
                      ),
                    ])
                  : null,
              footer: () => h("button", { onClick: requestClose }, "取消"),
            },
          );
      },
    });
    mount({
      render: () =>
        h(
          BaseDialog,
          { open: true, title: "父配置" },
          {
            default: () => [
              h(
                "section",
                { class: "config-discard", tabindex: -1 },
                "父配置尚未保存",
              ),
              h(
                "button",
                {
                  id: "child",
                  onClick: () => {
                    childOpen.value = true;
                  },
                },
                "子配置",
              ),
              h(Child),
            ],
          },
        ),
    });
    await nextTick();
    await click(document.querySelector("#child")!);
    changed.value = "edited";
    await nextTick();
    await click(dialog("子配置").querySelector(".dialog-footer button")!);
    await nextTick();
    expect(document.activeElement).toBe(
      dialog("子配置").querySelector(".config-discard"),
    );
    await click(document.querySelector("#discard")!);
    expect(dialog("子配置")).toBeNull();
    expect(dialog("父配置").inert).toBe(false);
  });
});
