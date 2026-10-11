<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  useId,
  watch,
  onMounted,
  onBeforeUnmount,
} from "vue";

import AppIcon from "../../../components/AppIcon.vue";
import type { FormField } from "@platform/contracts";
const props = defineProps<{
  items: { id: string; label: string }[];
  modelValue?: string;
  label: string;
  variant: "design" | "runtime" | "preview";
  appearance?: Pick<FormField, "tabStyle" | "tabCustomColor" | "tabColor">;
}>();
const emit = defineEmits<{
  select: [id: string, event: MouseEvent | KeyboardEvent];
}>();
const bar = ref<HTMLElement>();
const overflow = ref(false);
let observer: ResizeObserver | undefined;
function measure() {
  overflow.value =
    props.variant !== "preview" &&
    !!bar.value &&
    bar.value.scrollWidth >
      (bar.value.parentElement?.clientWidth || bar.value.clientWidth) + 1;
}
onMounted(measure);
watch(
  bar,
  (element) => {
    observer?.disconnect();
    if (typeof ResizeObserver !== "undefined" && element) {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    }
    measure();
  },
  { flush: "post" },
);
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => [props.items, props.appearance?.tabStyle],
  async () => {
    await nextTick();
    measure();
  },
  { deep: true },
);
const appearanceStyle = computed(() =>
  props.appearance?.tabCustomColor &&
  /^#[0-9a-f]{6}$/i.test(props.appearance.tabColor || "")
    ? { "--form-tab-accent": props.appearance.tabColor }
    : undefined,
);
const instanceId = useId();
const panelId = `${instanceId}-panel`;
const activeId = computed(() =>
  props.items.some((item) => item.id === props.modelValue)
    ? props.modelValue
    : props.items[0]?.id,
);
const tabId = (id: string) => `${instanceId}-tab-${id}`;
function activeButton() {
  return [
    ...(bar.value?.querySelectorAll<HTMLButtonElement>("button") || []),
  ].find((element) => element.id === tabId(activeId.value || ""));
}
watch(activeId, async () => {
  await nextTick();
  activeButton()?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
});
async function navigate(index: number, event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  let next: number;
  switch (event.key) {
    case "ArrowRight":
      next = (index + 1) % props.items.length;
      break;
    case "ArrowLeft":
      next = (index + props.items.length - 1) % props.items.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = props.items.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  const item = props.items[next];
  if (!item) return;
  emit("select", item.id, event);
  await nextTick();
  activeButton()?.focus({ preventScroll: true });
}
</script>
<template>
  <div
    v-if="items.length"
    class="form-tab-shell"
    :class="{ 'tab-preview': variant === 'preview' }"
    :style="appearanceStyle"
  >
    <button
      v-if="overflow"
      class="icon-button tab-scroll"
      type="button"
      :aria-label="`${label}向左滚动`"
      @click.stop="bar?.scrollBy({ left: -180, behavior: 'smooth' })"
    >
      <AppIcon name="back" />
    </button>
    <div
      ref="bar"
      :class="[
        variant === 'design' ? 'design-tabs' : 'runtime-tabs',
        `tab-style-${appearance?.tabStyle || 'line'}`,
      ]"
      :role="variant === 'preview' ? undefined : 'tablist'"
      :aria-label="variant === 'preview' ? undefined : label"
    >
      <template v-if="variant === 'preview'">
        <span
          v-for="item in items"
          :key="item.id"
          class="form-tab-item"
          :class="{ active: activeId === item.id }"
          ><span>{{ item.label }}</span></span
        >
      </template>
      <template v-else>
        <button
          v-for="(item, index) in items"
          :id="tabId(item.id)"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="activeId === item.id"
          :aria-controls="panelId"
          :tabindex="activeId === item.id ? 0 : -1"
          class="form-tab-item"
          :class="{ active: activeId === item.id }"
          @click.stop="emit('select', item.id, $event)"
          @keydown="navigate(index, $event)"
        >
          <span>{{ item.label }}</span>
        </button>
      </template>
    </div>
    <button
      v-if="overflow"
      class="icon-button tab-scroll"
      type="button"
      :aria-label="`${label}向右滚动`"
      @click.stop="bar?.scrollBy({ left: 180, behavior: 'smooth' })"
    >
      <AppIcon name="right" />
    </button>
  </div>
  <div
    v-if="activeId && variant !== 'preview'"
    :id="panelId"
    role="tabpanel"
    :aria-labelledby="tabId(activeId)"
  >
    <slot />
  </div>
  <slot v-else-if="variant !== 'preview'" />
</template>
