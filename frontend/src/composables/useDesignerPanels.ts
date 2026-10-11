import { onBeforeUnmount, ref } from "vue";

/** A field selection leads to its properties; narrow screens show one panel. */
export function useDesignerPanels() {
  let compact = window.innerWidth <= 800;
  const showPalette = ref(!compact),
    showInspector = ref(!compact);
  let activePanel: "palette" | "inspector" | undefined;
  function resize() {
    const next = window.innerWidth <= 800;
    if (next === compact) return;
    compact = next;
    showPalette.value = !compact || activePanel === "palette";
    showInspector.value = !compact || activePanel === "inspector";
  }
  function inspectField() {
    activePanel = "inspector";
    showInspector.value = true;
    if (compact) showPalette.value = false;
  }
  function togglePalette() {
    showPalette.value = !showPalette.value;
    activePanel = showPalette.value ? "palette" : undefined;
    if (showPalette.value && compact) showInspector.value = false;
  }
  function toggleInspector() {
    showInspector.value = !showInspector.value;
    activePanel = showInspector.value ? "inspector" : undefined;
    if (showInspector.value && compact) showPalette.value = false;
  }
  window.addEventListener("resize", resize);
  onBeforeUnmount(() => window.removeEventListener("resize", resize));
  return {
    showPalette,
    showInspector,
    inspectField,
    togglePalette,
    toggleInspector,
  };
}
