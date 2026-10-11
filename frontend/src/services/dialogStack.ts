/** One keyboard/focus owner for Vue-controlled dialogs and their nonmodal popovers. */
export function createDialogStack(doc: Document) {
  type Layer = {
    element: HTMLElement;
    close: () => void;
    previous: Element | null;
    modal: boolean;
    anchor?: () => HTMLElement | undefined;
    initialFocus?: () => HTMLElement | undefined;
    reposition?: () => void;
  };
  const layers: Layer[] = [];
  let previousOverflow = "",
    app: HTMLElement | null = null,
    previousInert = false;
  let sequence = 0;
  const top = () => layers.at(-1);
  const contains = (layer: Layer, element: Node | null) =>
    layer.element.contains(element) ||
    (!layer.modal && !!layer.anchor?.()?.contains(element));
  const controls = (element: HTMLElement) =>
    Array.from(
      element.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (el) =>
        el.tabIndex >= 0 &&
        !el.closest("[inert]") &&
        el.getClientRects().length > 0,
    );
  function focusFirst(layer: Layer) {
    const preferred = layer.initialFocus?.();
    (
      (preferred &&
      layer.element.contains(preferred) &&
      !preferred.closest("[inert]") &&
      !preferred.matches("[disabled]")
        ? preferred
        : undefined) ||
      controls(layer.element)[0] ||
      layer.element
    ).focus({
      preventScroll: true,
    });
  }
  function keydown(event: KeyboardEvent) {
    const layer = top();
    if (!layer || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      layer.close();
    } else if (event.key === "Tab" && layer.modal) {
      const items = controls(layer.element),
        index = items.indexOf(doc.activeElement as HTMLElement);
      if (
        !items.length ||
        index < 0 ||
        (event.shiftKey ? index === 0 : index === items.length - 1)
      ) {
        event.preventDefault();
        ((event.shiftKey ? items.at(-1) : items[0]) || layer.element).focus({
          preventScroll: true,
        });
      }
    }
  }
  function focusin() {
    const destination = doc.activeElement;
    for (const layer of [...layers].reverse()) {
      if (contains(layer, destination)) return;
      if (layer.modal) {
        focusFirst(layer);
        return;
      }
      layer.close();
    }
  }
  function outside(event: PointerEvent) {
    if (!(event.target instanceof Node)) return;
    for (const layer of [...layers].reverse()) {
      if (layer.modal || contains(layer, event.target)) return;
      layer.close();
    }
  }
  function anchorMoved(event: Event) {
    for (const layer of [...layers].reverse()) {
      const anchor = layer.anchor?.();
      if (layer.modal || !anchor) continue;
      if (
        event.type === "resize" ||
        (event.target instanceof Node &&
          event.target.contains(anchor) &&
          !layer.element.contains(event.target))
      )
        (layer.reposition || layer.close)();
    }
  }
  function updateInert() {
    let modal = -1;
    layers.forEach((layer, index) => {
      if (layer.modal) modal = index;
    });
    for (const [index, layer] of layers.entries())
      layer.element.inert = index < modal;
  }
  function register(
    element: HTMLElement,
    close: () => void,
    options: {
      modal?: boolean;
      anchor?: () => HTMLElement | undefined;
      initialFocus?: () => HTMLElement | undefined;
      reposition?: () => void;
    } = {},
  ) {
    const layer = {
      element,
      close,
      previous: options.anchor?.() || doc.activeElement,
      modal: options.modal !== false,
      anchor: options.anchor,
      initialFocus: options.initialFocus,
      reposition: options.reposition,
    };
    if (!layers.length) {
      previousOverflow = doc.body.style.overflow;
      app = doc.getElementById("app");
      previousInert = app?.inert || false;
      doc.addEventListener("keydown", keydown, true);
      doc.addEventListener("focusin", focusin);
      doc.addEventListener("pointerdown", outside, true);
      doc.addEventListener("scroll", anchorMoved, true);
      doc.defaultView?.addEventListener("resize", anchorMoved);
    }
    layers.push(layer);
    if (layers.some((layer) => layer.modal)) {
      doc.body.style.overflow = "hidden";
      if (app) app.inert = true;
    }
    updateInert();
    focusFirst(layer);
    let active = true;
    return {
      zIndex: 2000 + ++sequence,
      dispose() {
        if (!active) return;
        active = false;
        const wasTop = top() === layer;
        layers.splice(layers.indexOf(layer), 1);
        element.inert = false;
        updateInert();
        if (!layers.some((layer) => layer.modal)) {
          doc.body.style.overflow = previousOverflow;
          if (app) app.inert = previousInert;
        }
        if (!layers.length) {
          doc.body.style.overflow = previousOverflow;
          if (app) app.inert = previousInert;
          app = null;
          doc.removeEventListener("keydown", keydown, true);
          doc.removeEventListener("focusin", focusin);
          doc.removeEventListener("pointerdown", outside, true);
          doc.removeEventListener("scroll", anchorMoved, true);
          doc.defaultView?.removeEventListener("resize", anchorMoved);
        }
        if (
          wasTop &&
          (layer.modal ||
            element.contains(doc.activeElement) ||
            doc.activeElement === doc.body)
        ) {
          const previous = layer.previous as HTMLElement | null;
          if (
            previous?.isConnected &&
            typeof previous.focus === "function" &&
            !previous.closest("[inert]") &&
            (!top() || top()!.element.contains(previous))
          )
            previous.focus({ preventScroll: true });
          else if (top()) focusFirst(top()!);
        }
      },
    };
  }
  return { register };
}
