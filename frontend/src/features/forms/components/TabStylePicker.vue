<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { formTabStyles, type FormField } from "@platform/contracts";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import AppIcon from "../../../components/AppIcon.vue";
import FormTabBar from "./FormTabBar.vue";
const props = defineProps<{ field: FormField }>();
const emit = defineEmits<{
  select: [style: NonNullable<FormField["tabStyle"]>];
}>();
const trigger = ref<HTMLElement>(),
  panel = ref<HTMLElement>(),
  open = ref(false);
const position = ref({ left: "0px", top: "0px", width: "0px" });
const items = [1, 2, 3].map((i) => ({ id: String(i), label: `标签页${i}` }));
const { zIndex } = useDialogLayer(
  panel,
  () => (open.value = false),
  () => {},
  { modal: false, anchor: () => trigger.value },
);
watch(
  () => props.field.id,
  () => (open.value = false),
);
async function show() {
  open.value = !open.value;
  if (!open.value) return;
  const rect = trigger.value!.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 268), window.innerWidth - 24);
  position.value = {
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    top: `${rect.bottom + 4}px`,
    width: `${width}px`,
  };
  await nextTick();
  const height = panel.value!.getBoundingClientRect().height;
  if (rect.bottom + 4 + height > window.innerHeight - 12)
    position.value.top = `${Math.max(12, rect.top - height - 4)}px`;
  panel.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}
function choose(style: NonNullable<FormField["tabStyle"]>) {
  emit("select", style);
  open.value = false;
}
function navigate(index: number, event: KeyboardEvent) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (
    !keys.includes(event.key) ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey
  )
    return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? 4
        : (index + (event.key === "ArrowDown" ? 1 : 4)) % 5;
  panel.value?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus();
}
</script>
<template>
  <button
    ref="trigger"
    type="button"
    class="tab-style-trigger"
    aria-label="标签页样式"
    aria-haspopup="listbox"
    :aria-expanded="open"
    @click="show"
  >
    <FormTabBar
      :items="items"
      model-value="1"
      label=""
      variant="preview"
      :appearance="field"
    /><AppIcon name="down" :size="14" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="tab-style-menu"
      role="listbox"
      aria-label="标签页样式"
      :style="{ ...position, zIndex }"
    >
      <button
        v-for="(style, index) in formTabStyles"
        :key="style"
        type="button"
        role="option"
        :aria-label="`标签页样式 ${index + 1}`"
        :aria-selected="(field.tabStyle || 'line') === style"
        @click="choose(style)"
        @keydown="navigate(index, $event)"
      >
        <AppIcon
          v-if="style === 'card' || style === 'slant'"
          name="back"
          :size="16"
        />
        <FormTabBar
          :items="items"
          model-value="1"
          label=""
          variant="preview"
          :appearance="{ ...field, tabStyle: style }"
        />
        <AppIcon
          v-if="style === 'card' || style === 'slant'"
          name="right"
          :size="16"
        />
      </button>
    </div>
  </Teleport>
</template>
