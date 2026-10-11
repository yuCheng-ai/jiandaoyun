import { computed, onBeforeUnmount, ref, watch, nextTick } from "vue";
/** Independent history per editor document. Viewport and selection do not enter history. */
export function useEditorHistory<T>(read: () => T, write: (value: T) => void) {
  const snapshots = ref<string[]>([JSON.stringify(read())]);
  const index = ref(0);
  let restoring = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const canUndo = computed(() => index.value > 0);
  const canRedo = computed(() => index.value < snapshots.value.length - 1);
  function checkpoint() {
    clearTimeout(timer);
    const current = JSON.stringify(read());
    if (snapshots.value[index.value] === current) return;
    snapshots.value = snapshots.value.slice(0, index.value + 1);
    snapshots.value.push(current);
    if (snapshots.value.length > 80) snapshots.value.shift();
    index.value = snapshots.value.length - 1;
  }
  watch(
    () => JSON.stringify(read()),
    () => {
      if (restoring) return;
      clearTimeout(timer);
      timer = setTimeout(checkpoint, 250);
    },
  );
  async function restore(next: number) {
    restoring = true;
    index.value = next;
    write(JSON.parse(snapshots.value[next]!));
    await nextTick();
    restoring = false;
  }
  async function undo() {
    checkpoint();
    if (canUndo.value) await restore(index.value - 1);
  }
  async function redo() {
    clearTimeout(timer);
    if (canRedo.value) await restore(index.value + 1);
  }
  function transact(action: () => void) {
    checkpoint();
    action();
    checkpoint();
  }
  onBeforeUnmount(() => clearTimeout(timer));
  return { canUndo, canRedo, undo, redo, checkpoint, transact };
}
