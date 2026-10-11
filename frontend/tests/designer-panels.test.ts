// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h } from "vue";
import { useDesignerPanels } from "../src/composables/useDesignerPanels";
let app: ReturnType<typeof createApp>;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
function mount() {
  vi.stubGlobal("innerWidth", 1280);
  let panels!: ReturnType<typeof useDesignerPanels>;
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp({
    setup() {
      panels = useDesignerPanels();
      return () => h("div");
    },
  });
  app.mount("#mount");
  return panels;
}
function resize(width: number) {
  vi.stubGlobal("innerWidth", width);
  window.dispatchEvent(new Event("resize"));
}
it("keeps the active field inspector available when a desktop editor becomes narrow", () => {
  const panels = mount();
  panels.inspectField();
  resize(390);
  expect(panels.showInspector.value).toBe(true);
  expect(panels.showPalette.value).toBe(false);
  resize(1280);
  resize(390);
  expect(panels.showInspector.value).toBe(true);
  panels.toggleInspector();
  resize(1280);
  resize(390);
  expect(panels.showInspector.value).toBe(false);
});
it("leaves an untouched narrow canvas clear and preserves the chosen palette across breakpoints", () => {
  const panels = mount();
  resize(390);
  expect(panels.showInspector.value || panels.showPalette.value).toBe(false);
  panels.togglePalette();
  resize(1280);
  resize(390);
  expect(panels.showPalette.value).toBe(true);
  expect(panels.showInspector.value).toBe(false);
});
