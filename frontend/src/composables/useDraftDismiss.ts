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
  let leaving: ((allow: boolean) => void) | undefined;
  function finishLeave(allow: boolean) {
    const resolve = leaving;
    leaving = undefined;
    resolve?.(allow);
  }
  watch(confirmDiscard, (show) => {
    if (!show) finishLeave(false);
  });
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
    if (leaving) {
      finishLeave(true);
      confirmDiscard.value = false;
      return;
    }
    confirmDiscard.value = false;
    close();
  }
  /** 路由和页内切换共用同一次确认；无修改时直接放行。 */
  function confirmLeave(): boolean | Promise<boolean> {
    if (!dirty.value) return true;
    finishLeave(false);
    requestClose();
    return new Promise<boolean>((resolve) => {
      leaving = resolve;
    });
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value && !editorDraft?.retained.value) event.preventDefault();
  }
  window.addEventListener("beforeunload", beforeUnload);
  onBeforeUnmount(() => {
    finishLeave(false);
    window.removeEventListener("beforeunload", beforeUnload);
  });
  function markSaved(snapshot: unknown = value()) {
    editorDraft?.clear();
    // 保存期间可能仍有异步结果到达，只确认真正提交的那一份内容。
    initial.value = JSON.stringify(snapshot);
    finishLeave(true);
    confirmDiscard.value = false;
  }
  return {
    dirty,
    confirmDiscard,
    requestClose,
    confirmLeave,
    discard,
    markSaved,
    draftKey: editorDraft?.key,
  };
}
