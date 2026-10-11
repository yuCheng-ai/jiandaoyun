import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { uid } from "../domain/form";
import { useEditorDraftStore } from "../stores/editorDrafts";

export interface EditorDraftOptions {
  enabled?: () => boolean;
  autoPersist?: () => boolean;
  key: () => string;
  title: () => string;
  context: () => unknown;
  restore: (value: unknown) => void;
}
/** Keep recovery copies automatically, independently of an explicit business save. */
export function useEditorDraft(
  options: EditorDraftOptions,
  active: () => boolean,
  value: () => unknown,
  dirty: () => boolean,
) {
  const drafts = useEditorDraftStore(),
    route = useRoute();
  const id = ref(uid("draft"));
  let clearedValue: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const key = computed(options.key);
  let sourcePath = route.fullPath,
    sourceKey = key.value;
  let sourceContext = JSON.stringify(options.context());
  function begin() {
    id.value = uid("draft");
    clearedValue = undefined;
    sourcePath = route.fullPath;
    sourceKey = key.value;
    sourceContext = JSON.stringify(options.context());
  }
  function stopTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function persist() {
    stopTimer();
    if (options.autoPersist?.() === false) return;
    if (drafts.entries.some((d) => d.id === id.value))
      drafts.checkpoint(id.value);
  }
  function capture() {
    if (!active()) return;
    if (clearedValue !== undefined) {
      if (JSON.stringify(value()) === clearedValue) return;
      begin();
    }
    if (!dirty()) {
      stopTimer();
      drafts.remove(id.value, sourceKey);
      return;
    }
    const captured = drafts.capture({
      id: id.value,
      key: sourceKey,
      title: options.title(),
      path: sourcePath,
      context: sourceContext,
      value: value(),
      updatedAt: new Date().toISOString(),
    });
    stopTimer();
    if (captured) timer = setTimeout(persist, 350);
  }
  const unregister = drafts.register({
    draftId: () => id.value,
    flush,
    active,
    key: options.key,
    context: () => JSON.stringify(options.context()),
    value,
    restore: (next, source) => {
      options.restore(next);
      if (source) {
        stopTimer();
        // Adopt the restored copy, so saving/discarding it also clears its recovery entry.
        // Keep any prior copy if its removal fails; never report that as lost work.
        if (id.value !== source.id) drafts.remove(id.value, sourceKey);
        id.value = source.id;
        clearedValue = undefined;
      }
    },
  });
  watch(
    [active, key],
    ([open]) => {
      persist();
      if (open) begin();
      drafts.changed();
    },
    // Start the editing session before the post-render capture. Opening an
    // inline editor may replace its value before toggling active; both changes
    // must belong to one draft ID, otherwise a default-value copy is orphaned.
    { flush: "pre" },
  );
  watch(() => [active(), dirty(), value()], capture, {
    deep: true,
    flush: "post",
  });
  function clear() {
    stopTimer();
    clearedValue = JSON.stringify(value());
    drafts.remove(id.value, sourceKey);
  }
  const retained = computed(() => {
    const entry = drafts.entries.find((d) => d.id === id.value);
    return (
      !!entry &&
      JSON.stringify(entry.value) === JSON.stringify(value()) &&
      drafts.isCheckpoint(entry)
    );
  });
  function flush() {
    capture();
    persist();
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (!active() || !dirty()) return;
    flush();
    if (!retained.value) event.preventDefault();
  }
  window.addEventListener("beforeunload", beforeUnload);
  onBeforeUnmount(() => {
    flush();
    window.removeEventListener("beforeunload", beforeUnload);
    unregister();
  });
  return { key, clear, capture, flush, retained };
}
