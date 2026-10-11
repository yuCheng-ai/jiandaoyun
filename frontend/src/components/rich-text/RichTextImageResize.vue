<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ image: HTMLImageElement }>();
const emit = defineEmits<{
  resize: [width: string];
  resizing: [active: boolean];
  measure: [bounds: DOMRect];
}>();
const bounds = ref({ left: 0, top: 0, width: 0, height: 0 });
const corners = [
  { name: "左上", x: -1, y: -1 },
  { name: "右上", x: 1, y: -1 },
  { name: "左下", x: -1, y: 1 },
  { name: "右下", x: 1, y: 1 },
];
let observer: ResizeObserver | undefined;
let drag:
  | {
      pointer: number;
      handle: HTMLElement;
      x: number;
      y: number;
      width: number;
      ratio: number;
      dx: number;
      dy: number;
      original: string;
      image: HTMLImageElement;
    }
  | undefined;
function measure() {
  const rect = props.image.getBoundingClientRect();
  bounds.value = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  emit("measure", rect);
}
defineExpose({ measure });
function limit(width: number) {
  let container = props.image.parentElement;
  while (container && getComputedStyle(container).display === "inline")
    container = container.parentElement;
  if (!container) return bounds.value.width;
  const style = getComputedStyle(container);
  const maximum = Math.max(
    1,
    container.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0),
  );
  return Math.round(Math.max(Math.min(24, maximum), Math.min(width, maximum)));
}
function start(event: PointerEvent, corner: (typeof corners)[number]) {
  if (event.button !== 0 || drag || !props.image.isConnected) return;
  measure();
  if (!bounds.value.width || !bounds.value.height) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  handle.focus({ preventScroll: true });
  drag = {
    pointer: event.pointerId,
    handle,
    x: event.clientX,
    y: event.clientY,
    width: bounds.value.width,
    ratio: bounds.value.width / bounds.value.height,
    dx: corner.x,
    dy: corner.y,
    original: props.image.style.width,
    image: props.image,
  };
  emit("resizing", true);
  handle.setPointerCapture?.(event.pointerId);
}
function move(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return;
  const x = (event.clientX - drag.x) * drag.dx;
  const y = (event.clientY - drag.y) * drag.dy * drag.ratio;
  props.image.style.width = `${limit(drag.width + (Math.abs(x) >= Math.abs(y) ? x : y))}px`;
  measure();
}
function cancel() {
  if (!drag) return;
  const current = drag;
  drag = undefined;
  current.image.style.width = current.original;
  if (current.handle.hasPointerCapture?.(current.pointer))
    current.handle.releasePointerCapture(current.pointer);
  measure();
  emit("resizing", false);
}
function finish(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return;
  move(event);
  const width = props.image.style.width;
  const changed = Math.abs(bounds.value.width - drag.width) >= 1;
  // Restore before committing through the editor's native undoable command.
  cancel();
  if (changed && props.image.isConnected) emit("resize", width);
}
function interrupted(event: PointerEvent) {
  if (event.pointerId === drag?.pointer) cancel();
}
function key(event: KeyboardEvent) {
  const direction = (
    { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 } as Record<
      string,
      number
    >
  )[event.key];
  if (!direction || drag) return;
  event.preventDefault();
  measure();
  const width = limit(
    bounds.value.width + direction * (event.shiftKey ? 20 : 5),
  );
  if (Math.abs(width - bounds.value.width) >= 1) emit("resize", `${width}px`);
}
function observe() {
  measure();
  props.image.addEventListener("load", measure);
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(props.image);
  }
}
onMounted(observe);
watch(
  () => props.image,
  (_, previous) => {
    cancel();
    observer?.disconnect();
    previous.removeEventListener("load", measure);
    observe();
  },
);
onBeforeUnmount(() => {
  cancel();
  observer?.disconnect();
  props.image.removeEventListener("load", measure);
});
</script>

<template>
  <div
    v-if="bounds.width && bounds.height"
    class="rich-image-resize"
    :style="{
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    }"
  >
    <button
      v-for="corner in corners"
      :key="corner.name"
      type="button"
      class="rich-image-handle"
      :aria-label="`缩放图片（${corner.name}）`"
      title="拖动调整大小，方向键微调"
      :style="{
        left: corner.x < 0 ? '0%' : '100%',
        top: corner.y < 0 ? '0%' : '100%',
        cursor: corner.x === corner.y ? 'nwse-resize' : 'nesw-resize',
      }"
      @pointerdown="start($event, corner)"
      @pointermove="move"
      @pointerup="finish"
      @pointercancel="interrupted"
      @lostpointercapture="interrupted"
      @keydown="key"
    />
  </div>
</template>

<style scoped>
.rich-image-resize {
  position: fixed;
  box-sizing: border-box;
  border: 1px solid #00a49a;
  pointer-events: none;
}
.rich-image-resize .rich-image-handle {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 18px;
  height: 18px;
  min-width: 0;
  padding: 0;
  border: 5px solid transparent;
  border-radius: 0;
  background: #00a49a;
  background-clip: padding-box;
  pointer-events: auto;
  touch-action: none;
}
.rich-image-handle:focus-visible {
  outline: 2px solid #00877f;
}
</style>
