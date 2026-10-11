import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useEditorDraft, type EditorDraftOptions } from "./useEditorDraft";

/** Keeps a configuration dialog open until changes are saved or explicitly discarded. */
export function useDraftDismiss(
  isOpen: () => boolean,
  value: () => unknown,
  close: () => void,
  recovery?: EditorDraftOptions,
) {
  const initial = ref("");
  const confirmDiscard = ref(false);
  const dirty = computed(
    () => isOpen() && JSON.stringify(value()) !== initial.value,
  );
  watch(
    isOpen,
    (open) => {
      confirmDiscard.value = false;
      if (open) initial.value = JSON.stringify(value());
    },
    { immediate: true, flush: "post" },
  );
  const editorDraft = recovery
    ? useEditorDraft(
        recovery,
        () => isOpen() && (recovery.enabled?.() ?? true),
        value,
        () => dirty.value,
      )
    : undefined;
  function requestClose() {
    if (dirty.value) {
      // Capture the requesting layer before Vue renders the decision. A global
      // query can pick an inert parent's notice when dialogs are nested.
      const dialog =
        document.activeElement?.closest<HTMLElement>("dialog[open]");
      confirmDiscard.value = true;
      nextTick(() => {
        if (
          isOpen() &&
          confirmDiscard.value &&
          dialog?.isConnected &&
          !dialog.closest("[inert]")
        )
          dialog.querySelector<HTMLElement>(".config-discard")?.focus();
      });
    } else close();
  }
  function discard() {
    editorDraft?.clear();
    confirmDiscard.value = false;
    close();
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value && !editorDraft?.retained.value) event.preventDefault();
  }
  window.addEventListener("beforeunload", beforeUnload);
  onBeforeUnmount(() =>
    window.removeEventListener("beforeunload", beforeUnload),
  );
  function markSaved() {
    editorDraft?.clear();
    initial.value = JSON.stringify(value());
  }
  return {
    confirmDiscard,
    requestClose,
    discard,
    markSaved,
    draftKey: editorDraft?.key,
  };
}
