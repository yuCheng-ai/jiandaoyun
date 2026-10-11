<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from "vue";
import { choicePalette } from "@platform/contracts";
import { useDialogLayer } from "../composables/useDialogLayer";
import AppIcon from "./AppIcon.vue";
import CustomColorPanel from "./CustomColorPanel.vue";
import {
  customColorOwnerKey,
  normalizeCustomColors,
  readCustomColors,
  rememberCustomColor,
} from "../repositories/customColors";
const props = defineProps<{
  color: string;
  palette?: readonly string[];
  label: string;
  disabled?: boolean;
  swatch?: "circle" | "bar" | "text";
}>();
const emit = defineEmits<{ change: [color: string] }>();
const recommendedColors = computed(() => props.palette || choicePalette);
const owner = inject(customColorOwnerKey, ref(""));
const savedColors = ref<string[]>([]),
  pendingColor = ref<string>();
let customBase: { owner: string; color: string } | undefined;
function recommended(color: string) {
  return recommendedColors.value.some(
    (value) => value.toLowerCase() === color.toLowerCase(),
  );
}
const customColors = savedColors;
const trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>(),
  customTrigger = ref<HTMLButtonElement>(),
  open = ref(false),
  customOpen = ref(false);
const position = ref({ left: "0px", top: "0px" });
const { zIndex } = useDialogLayer(panel, close, () => {}, {
  modal: false,
  anchor: () => trigger.value,
});
async function show() {
  if (props.disabled) return;
  if (open.value) {
    close();
    return;
  }
  const rect = trigger.value!.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(rect.left + rect.width / 2 - 124, window.innerWidth - 256))}px`,
    top: `${Math.max(8, rect.bottom + 266 < window.innerHeight ? rect.bottom + 4 : rect.top - 262)}px`,
  };
  open.value = true;
  customOpen.value = false;
  pendingColor.value = undefined;
  const colors = normalizeCustomColors([
    ...readCustomColors(owner.value),
    ...savedColors.value,
  ]);
  savedColors.value =
    !recommended(props.color) && !colors.includes(props.color.toLowerCase())
      ? normalizeCustomColors([props.color, ...colors])
      : colors;
  await nextTick();
  const height = panel.value?.getBoundingClientRect().height || 262;
  position.value.top = `${Math.max(8, rect.bottom + 4 + height <= window.innerHeight - 8 ? rect.bottom + 4 : rect.top - height - 4)}px`;
  panel.value
    ?.querySelector<HTMLButtonElement>(`[aria-pressed="true"]`)
    ?.focus();
}
function choose(color: string) {
  customBase = undefined;
  pendingColor.value = undefined;
  customOpen.value = false;
  if (!props.disabled) emit("change", color);
}
function closeCustom() {
  const color = pendingColor.value;
  const base = customBase;
  customBase = undefined;
  pendingColor.value = undefined;
  customOpen.value = false;
  if (
    !color ||
    props.disabled ||
    !base ||
    base.owner !== owner.value ||
    base.color !== props.color
  )
    return;
  if (!recommended(color))
    savedColors.value = normalizeCustomColors([
      color,
      ...savedColors.value,
      ...rememberCustomColor(owner.value, color),
    ]);
  if (props.color.toLowerCase() !== color) emit("change", color);
}
function toggleCustom() {
  if (props.disabled) return;
  if (customOpen.value) closeCustom();
  else {
    customBase = { owner: owner.value, color: props.color };
    pendingColor.value = undefined;
    customOpen.value = true;
  }
}
function close() {
  closeCustom();
  open.value = false;
}
watch(
  () => props.color,
  () => {
    pendingColor.value = undefined;
  },
);
watch([() => props.disabled, owner], () => {
  pendingColor.value = undefined;
  close();
  savedColors.value = [];
});
</script>
<template>
  <button
    ref="trigger"
    type="button"
    class="option-color"
    :class="swatch && `option-color-${swatch}`"
    :style="swatch === 'text' ? { color } : { backgroundColor: color }"
    :aria-label="`${label}颜色`"
    :disabled="disabled"
    :aria-expanded="open"
    @click="show"
  >
    <template v-if="swatch === 'text'"
      ><u>A</u><AppIcon name="down" :size="12"
    /></template>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="option-color-panel"
      role="dialog"
      :aria-label="`${label}颜色`"
      :style="{ ...position, zIndex }"
    >
      <p>推荐颜色</p>
      <div class="option-color-grid">
        <button
          v-for="value in recommendedColors"
          :key="value"
          type="button"
          :aria-label="`颜色 ${value}`"
          :aria-pressed="color.toLowerCase() === value.toLowerCase()"
          @click="choose(value)"
        >
          <span class="option-color-dot" :style="{ backgroundColor: value }" />
        </button>
      </div>
      <div class="option-custom-colors">
        <p>自定义颜色</p>
        <div>
          <button
            ref="customTrigger"
            type="button"
            class="option-custom-add"
            :class="{ 'is-white': pendingColor === '#ffffff' }"
            :style="
              pendingColor ? { backgroundColor: pendingColor } : undefined
            "
            title="添加自定义颜色"
            :aria-label="`${label}自定义颜色`"
            :aria-expanded="customOpen"
            :disabled="disabled"
            @click="toggleCustom"
          >
            <AppIcon v-if="!pendingColor" name="add" :size="16" />
          </button>
          <button
            v-for="value in customColors"
            :key="value"
            type="button"
            class="option-custom-color"
            :aria-label="`自定义颜色 ${value}`"
            :aria-pressed="color.toLowerCase() === value"
            @click="choose(value)"
          >
            <span
              class="option-color-dot"
              :class="{ 'is-white': value === '#ffffff' }"
              :style="{ backgroundColor: value }"
            />
          </button>
        </div>
      </div>
      <CustomColorPanel
        v-if="customOpen"
        :color="color"
        :label="label"
        :anchor="customTrigger"
        :disabled="disabled"
        @change="pendingColor = $event"
        @close="closeCustom"
      />
    </div>
  </Teleport>
</template>
<style scoped>
.option-color {
  border: 0;
  border-radius: 50%;
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  padding: 0;
  cursor: pointer;
}
.option-color:focus-visible {
  outline: 2px solid #00ada1;
  outline-offset: 3px;
}
.option-color-bar {
  width: 100%;
  height: 30px;
  flex: 0 0 auto;
  border: 3px solid white;
  outline: 1px solid #dce1e7;
  outline-offset: -1px;
  border-radius: 2px;
}
.option-color-text {
  width: 42px;
  height: 26px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid #dce1e7;
  border-radius: 2px;
  background: white;
}
.option-color-panel {
  position: fixed;
  width: 248px;
  max-width: calc(100vw - 16px);
  padding: 16px;
  max-height: calc(100vh - 16px);
  overflow: auto;
  border-radius: 5px;
  background: white;
  box-shadow: 0 6px 28px #24374730;
  border: 0;
  font-size: 12px;
  line-height: 20px;
}
.option-color-panel p {
  margin: 0 0 12px;
}
.option-color-grid {
  display: flex;
  flex-wrap: wrap;
  margin: -6px -4px;
}
.option-color-grid button {
  border: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  margin: 3px 2px;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.option-color-grid button[aria-pressed="true"] {
  outline: 1px solid #00ada1;
  outline-offset: 0;
}
.option-color-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
}
.option-custom-colors {
  margin-top: 16px;
}
.option-custom-colors > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin: -6px -4px;
}
.option-custom-add {
  position: relative;
  width: 20px;
  height: 20px;
  margin: 6px 4px;
  border: 1px solid #dce1e7;
  border-radius: 50%;
  color: #748196;
  background: white;
  padding: 0;
  cursor: pointer;
}
.option-color-panel .option-custom-add {
  display: flex;
  align-items: center;
  justify-content: center;
}
.option-custom-add:focus-within {
  outline: 2px solid #00ada1;
  outline-offset: 2px;
}
.option-custom-color {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: 3px 2px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}
.option-custom-color[aria-pressed="true"] {
  outline: 1px solid #00ada1;
  outline-offset: 0;
}
.is-white {
  border: 1px solid #dce1e7;
}
</style>
