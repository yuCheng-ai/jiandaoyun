<script setup lang="ts">
import { ref, watch } from "vue";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import { sanitizeRichText } from "../../../domain/richText";
import AppIcon from "../../../components/AppIcon.vue";
const props = defineProps<{ label: string; description: string }>();
const open = ref(false),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>();
const position = ref({ left: "0px", top: "0px", maxHeight: "80dvh" });
const close = () => {
  open.value = false;
};
const { zIndex } = useDialogLayer(panel, close, () => {}, {
  modal: false,
  anchor: () => trigger.value,
});
function toggle() {
  if (open.value) return close();
  trigger.value?.focus();
  const rect = trigger.value!.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 100));
  position.value = {
    left:
      Math.max(
        8,
        Math.min(
          rect.left,
          window.innerWidth - Math.min(320, window.innerWidth - 16) - 8,
        ),
      ) + "px",
    top: top + "px",
    maxHeight: `calc(100dvh - ${top + 8}px)`,
  };
  open.value = true;
}
watch(() => props.description, close);
</script>
<template>
  <button
    ref="trigger"
    type="button"
    class="icon-button field-description-trigger"
    :aria-label="`查看${label}的描述`"
    :aria-expanded="open"
    aria-haspopup="dialog"
    @click="toggle"
  >
    <AppIcon name="help" :size="14" />
  </button>
  <Teleport to="body"
    ><div
      v-if="open"
      ref="panel"
      class="field-description-popover"
      role="dialog"
      :aria-label="`${label}的描述`"
      tabindex="-1"
      :style="{ ...position, zIndex }"
    >
      <div
        class="field-description"
        v-html="sanitizeRichText(description)"
      /></div
  ></Teleport>
</template>
<style>
.field-description-trigger {
  width: 20px;
  height: 20px;
  min-width: 20px;
  color: #a4abb5;
  padding: 0;
  flex-shrink: 0;
}
.field-description-popover {
  position: fixed;
  width: 320px;
  max-width: calc(100vw - 16px);
  max-height: 80dvh;
  overflow: auto;
  padding: 12px 14px;
  background: white;
  border: 1px solid #dadee5;
  border-radius: 5px;
  box-shadow: 0 5px 20px #131d2e26;
}
.field-description-popover .field-description {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
