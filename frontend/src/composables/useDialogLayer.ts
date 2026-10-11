import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { createDialogStack } from "../services/dialogStack";
let stack: ReturnType<typeof createDialogStack> | undefined;

/** Visibility belongs to Vue; this hook owns only focus, layering and page scroll. */
export function useDialogLayer(
  element: Ref<HTMLElement | undefined>,
  requestClose: () => void,
  closed: () => void = () => {},
  options: {
    modal?: boolean;
    anchor?: () => HTMLElement | undefined;
    initialFocus?: () => HTMLElement | undefined;
    reposition?: () => void;
  } = {},
) {
  const zIndex = ref(2000);
  let dispose: (() => void) | undefined;
  function release() {
    dispose?.();
    dispose = undefined;
  }
  watch(
    element,
    (next, previous) => {
      release();
      if (next) {
        stack ||= createDialogStack(document);
        const layer = stack.register(next, requestClose, options);
        dispose = layer.dispose;
        zIndex.value = layer.zIndex;
      } else if (previous) closed();
    },
    { flush: "post" },
  );
  onBeforeUnmount(release);
  return { zIndex };
}
