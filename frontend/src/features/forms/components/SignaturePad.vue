<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
const props = withDefaults(
  defineProps<{ modelValue: unknown; disabled?: boolean; label?: string }>(),
  { label: "手写签名" },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
type Point = { x: number; y: number };
const canvas = ref<HTMLCanvasElement>();
const open = ref(false),
  landscape = ref(false),
  hasInk = ref(false);
const error = ref("");
const storedImage = computed(() =>
  typeof props.modelValue === "string" &&
  /^data:image\/(png|jpeg|gif|webp);base64,/.test(props.modelValue)
    ? props.modelValue
    : "",
);
const hasValue = computed(
  () => props.modelValue != null && props.modelValue !== "",
);
let strokes: Point[][] = [];
let current: { pointerId: number; points: Point[] } | undefined;
function draw(points: Point[]) {
  const ctx = canvas.value?.getContext("2d");
  if (!ctx || points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}
function redraw() {
  const el = canvas.value;
  el?.getContext("2d")?.clearRect(0, 0, el.width, el.height);
  for (const stroke of strokes) draw(stroke);
  if (current) draw(current.points);
}
function releasePointer() {
  const id = current?.pointerId;
  current = undefined;
  if (id != null && canvas.value?.hasPointerCapture?.(id))
    canvas.value.releasePointerCapture(id);
}
function reset() {
  releasePointer();
  strokes = [];
  hasInk.value = false;
  error.value = "";
  redraw();
}
async function start() {
  if (props.disabled) return;
  reset();
  landscape.value = false;
  open.value = true;
  await nextTick();
  redraw();
}
function close() {
  open.value = false;
  reset();
}
function point(event: PointerEvent): Point | undefined {
  const el = canvas.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // Mobile rotation changes the bounds; map back to the original canvas axes.
  const rotated = landscape.value && window.innerWidth <= 640;
  const x = rotated
    ? (event.clientY - rect.top) / rect.height
    : (event.clientX - rect.left) / rect.width;
  const y = rotated
    ? 1 - (event.clientX - rect.left) / rect.width
    : (event.clientY - rect.top) / rect.height;
  return {
    x: Math.max(0, Math.min(1, x)) * el.width,
    y: Math.max(0, Math.min(1, y)) * el.height,
  };
}
function down(event: PointerEvent) {
  if (props.disabled || !open.value || current || event.button !== 0) return;
  const p = point(event);
  if (!p) return;
  current = { pointerId: event.pointerId, points: [p] };
  canvas.value?.setPointerCapture?.(event.pointerId);
  error.value = "";
  event.preventDefault();
}
function move(event: PointerEvent) {
  if (props.disabled || current?.pointerId !== event.pointerId) return;
  const p = point(event),
    previous = current.points.at(-1)!;
  if (!p || Math.hypot(p.x - previous.x, p.y - previous.y) < 0.5) return;
  current.points.push(p);
  draw([previous, p]);
  event.preventDefault();
}
function finish(event: PointerEvent) {
  if (current?.pointerId !== event.pointerId) return;
  if (!props.disabled && current.points.length > 1) {
    strokes.push(current.points);
    hasInk.value = true;
  }
  releasePointer();
  redraw();
}
function cancelStroke(event: PointerEvent) {
  if (current?.pointerId !== event.pointerId) return;
  releasePointer();
  redraw();
}
function rotate() {
  releasePointer();
  landscape.value = !landscape.value;
  redraw();
}
function confirm() {
  if (props.disabled || !open.value || !hasInk.value || current) return;
  try {
    const value = canvas.value?.toDataURL("image/png");
    if (!value || !value.startsWith("data:image/png;base64,"))
      throw new Error("Signature image unavailable");
    emit("update:modelValue", value);
    close();
  } catch {
    error.value = "签名未能保存，请重试。";
  }
}
function clearValue() {
  if (!props.disabled) emit("update:modelValue", "");
}
watch([() => props.disabled, () => props.modelValue], () => {
  if (open.value) close();
});
</script>
<template>
  <div class="signature-control">
    <div v-if="hasValue" class="signature-value">
      <img v-if="storedImage" :src="storedImage" :alt="label" />
      <span v-else class="field-hint">签名无法显示</span>
      <div v-if="!disabled" class="signature-value-actions">
        <button type="button" class="text-button" @click="start">
          重新签名
        </button>
        <button
          type="button"
          class="text-button"
          :aria-label="`清除${label}`"
          @click="clearValue"
        >
          清除
        </button>
      </div>
    </div>
    <button
      v-else
      type="button"
      class="signature-add"
      :disabled="disabled"
      :aria-label="`添加${label}`"
      @click="start"
    >
      <AppIcon name="pen" :size="17" />添加签名
    </button>
  </div>
  <BaseDialog
    :open="open"
    title="手写签名"
    width="640px"
    :class-name="`signature-dialog${landscape ? ' is-landscape' : ''}`"
    @close="close"
  >
    <div class="signature-sheet">
      <p class="signature-instruction">请在下方区域内横向书写</p>
      <canvas
        ref="canvas"
        width="900"
        height="510"
        :aria-label="`${label}书写区域`"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="finish"
        @pointercancel="cancelStroke"
        @lostpointercapture="cancelStroke"
      />
      <div class="signature-rewrite">
        <button type="button" class="text-button" @click="reset">
          <AppIcon name="refresh" />重写
        </button>
      </div>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <div class="signature-confirm">
        <button
          type="button"
          class="icon-button signature-rotate"
          :aria-label="landscape ? '切换竖屏书写' : '切换横屏书写'"
          @click="rotate"
        >
          <AppIcon name="rotatePhone" :size="24" />
        </button>
        <button
          type="button"
          class="button primary"
          :disabled="!hasInk"
          @click="confirm"
        >
          确定
        </button>
      </div>
    </div>
  </BaseDialog>
</template>
