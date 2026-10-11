<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useDialogLayer } from "../composables/useDialogLayer";
import "./custom-color-source.css";

const props = defineProps<{
  color: string;
  label: string;
  anchor?: HTMLElement;
  disabled?: boolean;
}>();
const emit = defineEmits<{ change: [color: string]; close: [] }>();
const panel = ref<HTMLElement>();
const position = ref({ left: "8px", top: "8px" });
const hsv = reactive({ h: 0, s: 0, v: 1 });
const hex = ref("#FFFFFF"),
  rgb = ref(["255", "255", "255"]);
const { zIndex } = useDialogLayer(
  panel,
  () => emit("close"),
  () => {},
  {
    modal: false,
    anchor: () => props.anchor,
  },
);
function toHex(h = hsv.h, s = hsv.s, v = hsv.v) {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return (
    "#" +
    [channel(5), channel(3), channel(1)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
  );
}
const preview = computed(() => toHex());
const lastPreview = ref(props.color.toLowerCase());
const hueColor = computed(() => toHex(hsv.h, 1, 1));
const hexValid = computed(() => /^#[\da-f]{6}$/i.test(hex.value));
function rgbChannelValid(value: string) {
  return /^(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])$/.test(value);
}
function updateRgbInputs() {
  const value = preview.value;
  rgb.value = [1, 3, 5].map((i) =>
    String(Number.parseInt(value.slice(i, i + 2), 16)),
  );
}
function updateInputs() {
  hex.value = preview.value.toUpperCase();
  updateRgbInputs();
}
function readColor(value: string, syncInputs = true) {
  if (!/^#[\da-f]{6}$/i.test(value)) return;
  const [r, g, b] = [1, 3, 5].map(
    (i) => Number.parseInt(value.slice(i, i + 2), 16) / 255,
  ) as [number, number, number];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  if (delta)
    hsv.h =
      ((max === r
        ? (g - b) / delta
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4) *
        60 +
        360) %
      360;
  hsv.s = max ? delta / max : 0;
  hsv.v = max;
  if (syncInputs) updateInputs();
}
function commit() {
  if (!props.disabled && preview.value !== lastPreview.value) {
    lastPreview.value = preview.value;
    emit("change", preview.value);
  }
}
function changeHex(event: Event) {
  if (props.disabled) return;
  hex.value = (event.target as HTMLInputElement).value;
  if (hex.value.length === 6 && !hex.value.startsWith("#"))
    hex.value = `#${hex.value}`;
  if (!hexValid.value) return;
  readColor(hex.value, false);
  updateRgbInputs();
  commit();
}
function applyRgb() {
  if (!rgb.value.every(rgbChannelValid)) return;
  readColor(
    "#" +
      rgb.value.map((n) => Number(n).toString(16).padStart(2, "0")).join(""),
    false,
  );
  hex.value = preview.value.toUpperCase();
  commit();
}
function changeRgb(index: number, event: Event) {
  if (props.disabled) return;
  rgb.value[index] = (event.target as HTMLInputElement).value;
  applyRgb();
}
function blurRgb(index: number) {
  if (props.disabled || rgbChannelValid(rgb.value[index] || "")) return;
  rgb.value[index] = String(
    Math.max(
      0,
      Math.min(255, Number.parseInt(rgb.value[index] || "", 10) || 0),
    ),
  );
  applyRgb();
}
function changeHue(event: Event) {
  if (props.disabled) return;
  hsv.h = Number((event.target as HTMLInputElement).value);
  updateInputs();
}
let drag: { id: number; element: HTMLElement; before: string } | undefined;
function sample(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id || props.disabled) return;
  const rect = drag.element.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  hsv.s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  hsv.v =
    1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  updateInputs();
}
function startDrag(event: PointerEvent) {
  if (props.disabled || drag || event.button !== 0) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.focus();
  drag = { id: event.pointerId, element, before: preview.value };
  element.setPointerCapture?.(event.pointerId);
  sample(event);
}
function finishDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  sample(event);
  drag = undefined;
  commit();
}
function cancelDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  const before = drag.before;
  drag = undefined;
  readColor(before);
}
function moveColor(event: KeyboardEvent) {
  if (props.disabled) return;
  const step = event.shiftKey ? 0.1 : 0.01;
  switch (event.key) {
    case "ArrowLeft":
      hsv.s -= step;
      break;
    case "ArrowRight":
      hsv.s += step;
      break;
    case "ArrowUp":
      hsv.v += step;
      break;
    case "ArrowDown":
      hsv.v -= step;
      break;
    case "Home":
      hsv.s = 0;
      break;
    case "End":
      hsv.s = 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  hsv.s = Math.max(0, Math.min(1, hsv.s));
  hsv.v = Math.max(0, Math.min(1, hsv.v));
  updateInputs();
  commit();
}
readColor(props.color);
watch(
  () => props.color,
  (value) => {
    drag = undefined;
    readColor(value);
    lastPreview.value = preview.value;
  },
);
onMounted(async () => {
  await nextTick();
  const anchor = props.anchor?.getBoundingClientRect();
  const rect = panel.value?.getBoundingClientRect();
  if (!anchor || !rect) return;
  position.value = {
    left: `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - rect.width / 2, window.innerWidth - rect.width - 8))}px`,
    top: `${Math.max(8, Math.min(anchor.top - rect.height - 4 >= 8 ? anchor.top - rect.height - 4 : anchor.bottom + 4, window.innerHeight - rect.height - 8))}px`,
  };
});
</script>
<template>
  <Teleport to="body">
    <div
      ref="panel"
      class="custom-color-panel without-opacity"
      role="dialog"
      :aria-label="`${label}自定义颜色`"
      :style="{ ...position, zIndex }"
    >
      <div class="header-wrapper">
        <div
          class="x-sv-panel"
          role="slider"
          tabindex="0"
          aria-label="饱和度与亮度"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(hsv.s * 100)"
          :aria-valuetext="`饱和度 ${Math.round(hsv.s * 100)}%，亮度 ${Math.round(hsv.v * 100)}%`"
          :style="{ backgroundColor: hueColor }"
          @pointerdown="startDrag"
          @pointermove="sample"
          @pointerup="finishDrag"
          @pointercancel="cancelDrag"
          @lostpointercapture="cancelDrag"
          @keydown="moveColor"
        >
          <div class="x-sv-panel-white" />
          <div class="x-sv-panel-black" />
          <div
            class="x-sv-panel-cursor"
            :style="{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }"
          >
            <div />
          </div>
        </div>
      </div>
      <div class="main-wrapper">
        <div class="main-left">
          <div class="color-value" :style="{ backgroundColor: preview }" />
        </div>
        <div class="main-right">
          <div class="x-hue-slider">
            <div
              class="x-hue-slider-cursor"
              :style="{
                left: `calc(${(hsv.h / 360) * 100}% - 6px)`,
                backgroundColor: preview,
              }"
            />
            <input
              type="range"
              min="0"
              max="360"
              step="1"
              :value="hsv.h"
              :disabled="disabled"
              aria-label="色相"
              @input="changeHue"
              @change="commit"
            />
          </div>
        </div>
      </div>
      <div class="footer-wrapper">
        <label class="region-wrapper hex-input"
          ><span class="region-title">HEX</span
          ><input
            type="text"
            maxlength="7"
            spellcheck="false"
            autocomplete="off"
            :aria-label="`${label} HEX`"
            :value="hex"
            :disabled="disabled"
            :aria-invalid="!hexValid"
            @input="changeHex"
        /></label>
        <div class="region-divider" />
        <label
          v-for="(channel, index) in ['R', 'G', 'B']"
          :key="channel"
          class="region-wrapper rgb-input"
          ><span class="region-title">{{ channel }}</span
          ><input
            type="number"
            min="0"
            max="255"
            step="1"
            :aria-label="`${label} ${channel}`"
            :value="rgb[index]"
            :disabled="disabled"
            :aria-invalid="!rgbChannelValid(rgb[index] || '')"
            @input="changeRgb(index, $event)"
            @blur="blurRgb(index)"
        /></label>
      </div>
    </div>
  </Teleport>
</template>
