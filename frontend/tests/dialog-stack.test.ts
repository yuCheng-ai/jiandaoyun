import { describe, expect, it, vi } from "vitest";
import { createDialogStack } from "../src/services/dialogStack";

function browserFixture() {
  const listeners = new Map<string, (event: any) => void>();
  let active: any;
  const element = (parent?: any): any => {
    const el: any = {
      parent,
      inert: false,
      isConnected: true,
      tabIndex: 0,
      controls: [],
      hidden: false,
      focus: vi.fn(() => {
        active = el;
      }),
      closest: () => (el.inert ? el : el.parent?.closest() || null),
      getClientRects: () => (el.hidden ? [] : [{}]),
      contains: (other: any) =>
        !!other && (other === el || el.contains(other.parent)),
      querySelectorAll: () => el.controls,
    };
    return el;
  };
  const app = element(),
    trigger = element(app);
  active = trigger;
  const doc = {
    get activeElement() {
      return active;
    },
    body: { style: { overflow: "auto" } },
    getElementById: () => app,
    addEventListener: vi.fn((name, handler) => listeners.set(name, handler)),
    removeEventListener: vi.fn((name) => listeners.delete(name)),
    defaultView: {
      addEventListener: vi.fn((name, handler) =>
        listeners.set(`window:${name}`, handler),
      ),
      removeEventListener: vi.fn((name) => listeners.delete(`window:${name}`)),
    },
  };
  const dialog = () => {
    const root = element(),
      first = element(root),
      last = element(root),
      hidden = element(root);
    hidden.hidden = true;
    root.controls = [first, hidden, last];
    return { root, first, last };
  };
  const key = (key: string, shiftKey = false) => {
    const event = {
      key,
      shiftKey,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    listeners.get("keydown")?.(event);
    return event;
  };
  return {
    stack: createDialogStack(doc as unknown as Document),
    doc,
    app,
    trigger,
    dialog,
    key,
    listeners,
    active: () => active,
  };
}

describe("shared dialog keyboard and focus ownership", () => {
  it("repositions supported popovers on layout changes and retains the default close policy", () => {
    const f = browserFixture(),
      first = f.dialog(),
      second = f.dialog();
    const closeFirst = vi.fn(),
      closeSecond = vi.fn(),
      reposition = vi.fn();
    const a = f.stack.register(first.root, closeFirst, {
      modal: false,
      anchor: () => f.trigger,
    });
    const b = f.stack.register(second.root, closeSecond, {
      modal: false,
      anchor: () => first.first,
      reposition,
    });
    f.listeners.get("window:resize")?.({ type: "resize" });
    expect(reposition).toHaveBeenCalledOnce();
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).not.toHaveBeenCalled();
    expect(f.active()).toBe(second.first);
    f.key("Escape");
    expect(closeSecond).toHaveBeenCalledOnce();
    b.dispose();
    a.dispose();
    expect(f.listeners.size).toBe(0);
  });
  it("leaving nested nonmodal pickers closes the whole abandoned branch without moving destination focus", () => {
    const f = browserFixture(),
      parent = f.dialog(),
      child = f.dialog(),
      elsewhere = f.dialog();
    const closeParent = vi.fn(),
      closeChild = vi.fn();
    const outer = f.stack.register(parent.root, closeParent, {
      modal: false,
      anchor: () => f.trigger,
    });
    parent.last.focus();
    const inner = f.stack.register(child.root, closeChild, {
      modal: false,
      anchor: () => parent.last,
    });
    f.listeners.get("focusin")?.({});
    expect(closeParent).not.toHaveBeenCalled();
    expect(closeChild).not.toHaveBeenCalled();
    parent.first.focus();
    f.listeners.get("focusin")?.({});
    expect(closeChild).toHaveBeenCalledOnce();
    expect(closeParent).not.toHaveBeenCalled();
    closeChild.mockClear();
    elsewhere.first.focus();
    f.listeners.get("focusin")?.({});
    expect(closeChild).toHaveBeenCalledOnce();
    expect(closeParent).toHaveBeenCalledOnce();
    inner.dispose();
    outer.dispose();
    expect(f.active()).toBe(elsewhere.first);
  });
  it("a nonmodal anchor belongs to its popover while other focus destinations still close it", () => {
    const f = browserFixture(),
      popup = f.dialog(),
      close = vi.fn();
    const layer = f.stack.register(popup.root, close, {
      modal: false,
      anchor: () => f.trigger,
    });
    f.trigger.focus();
    f.listeners.get("focusin")?.({});
    expect(close).not.toHaveBeenCalled();
    const other = f.dialog();
    other.first.focus();
    f.listeners.get("focusin")?.({});
    expect(close).toHaveBeenCalledOnce();
    layer.dispose();
    expect(f.active()).toBe(other.first);
  });
  it("a nonmodal popover uses shared Escape handling without locking the workbench", () => {
    const f = browserFixture(),
      popup = f.dialog(),
      close = vi.fn();
    const layer = f.stack.register(popup.root, close, { modal: false });
    expect(f.app.inert).toBe(false);
    expect(f.doc.body.style.overflow).toBe("auto");
    expect(f.key("Tab").preventDefault).not.toHaveBeenCalled();
    f.key("Escape");
    expect(close).toHaveBeenCalledOnce();
    layer.dispose();
    expect(f.active()).toBe(f.trigger);
    expect(f.listeners.size).toBe(0);
  });
  it("closing a calendar leaves the parent preview usable and Escape stays with the top layer", () => {
    const f = browserFixture(),
      parent = f.dialog(),
      popup = f.dialog(),
      parentClose = vi.fn(),
      popupClose = vi.fn();
    const outer = f.stack.register(parent.root, parentClose);
    parent.last.focus();
    const inner = f.stack.register(popup.root, popupClose, { modal: false });
    expect(parent.root.inert).toBe(false);
    expect(f.app.inert).toBe(true);
    f.key("Escape");
    expect(popupClose).toHaveBeenCalledOnce();
    expect(parentClose).not.toHaveBeenCalled();
    inner.dispose();
    expect(f.active()).toBe(parent.last);
    f.key("Escape");
    expect(parentClose).toHaveBeenCalledOnce();
    outer.dispose();
  });
  it("leaving a nonmodal popover by Tab closes it and keeps focus on the chosen destination", () => {
    const f = browserFixture(),
      popup = f.dialog();
    let layer: ReturnType<typeof f.stack.register>;
    layer = f.stack.register(popup.root, () => layer.dispose(), {
      modal: false,
    });
    f.trigger.focus();
    f.listeners.get("focusin")?.({});
    expect(f.active()).toBe(f.trigger);
    expect(f.listeners.size).toBe(0);
  });
  it("keeps both Tab directions inside a dialog with no available controls", () => {
    const f = browserFixture(),
      d = f.dialog();
    d.root.controls = [];
    const layer = f.stack.register(d.root, () => {});
    expect(f.active()).toBe(d.root);
    for (const reverse of [false, true]) {
      f.trigger.focus();
      expect(f.key("Tab", reverse).preventDefault).toHaveBeenCalledOnce();
      expect(f.active()).toBe(d.root);
    }
    layer.dispose();
  });
  it("traps focus in visible controls and restores the page after close", () => {
    const f = browserFixture(),
      d = f.dialog(),
      close = vi.fn();
    const layer = f.stack.register(d.root, close);
    expect(f.active()).toBe(d.first);
    expect(f.app.inert).toBe(true);
    expect(f.doc.body.style.overflow).toBe("hidden");
    expect(f.key("Tab", true).preventDefault).toHaveBeenCalledOnce();
    expect(f.active()).toBe(d.last);
    f.key("Tab");
    expect(f.active()).toBe(d.first);
    f.key("Escape");
    expect(close).toHaveBeenCalledOnce();
    layer.dispose();
    layer.dispose();
    expect(f.app.inert).toBe(false);
    expect(f.doc.body.style.overflow).toBe("auto");
    expect(f.active()).toBe(f.trigger);
    expect(f.listeners.size).toBe(0);
  });
  it("closes only the nested layer and returns focus to its parent", () => {
    const f = browserFixture(),
      parent = f.dialog(),
      child = f.dialog();
    const closeParent = vi.fn(),
      closeChild = vi.fn();
    const outer = f.stack.register(parent.root, closeParent);
    parent.last.focus();
    const inner = f.stack.register(child.root, closeChild);
    expect(inner.zIndex).toBeGreaterThan(outer.zIndex);
    expect(parent.root.inert).toBe(true);
    f.key("Escape");
    expect(closeChild).toHaveBeenCalledOnce();
    expect(closeParent).not.toHaveBeenCalled();
    inner.dispose();
    expect(parent.root.inert).toBe(false);
    expect(f.active()).toBe(parent.last);
    expect(f.app.inert).toBe(true);
    f.key("Escape");
    expect(closeParent).toHaveBeenCalledOnce();
    outer.dispose();
  });
  it("keeps a guarded dialog active and cleans up correctly when a parent unmounts first", () => {
    const f = browserFixture(),
      parent = f.dialog(),
      child = f.dialog();
    f.app.inert = true;
    const outer = f.stack.register(parent.root, () => {});
    const guarded = vi.fn();
    const inner = f.stack.register(child.root, guarded);
    outer.dispose();
    parent.root.isConnected = false;
    parent.last.isConnected = false;
    f.key("Escape");
    expect(guarded).toHaveBeenCalledOnce();
    expect(f.doc.body.style.overflow).toBe("hidden");
    f.trigger.focus();
    f.listeners.get("focusin")?.({});
    expect(f.active()).toBe(child.first);
    inner.dispose();
    expect(f.app.inert).toBe(true);
    expect(f.doc.body.style.overflow).toBe("auto");
    expect(f.listeners.size).toBe(0);
  });
});
