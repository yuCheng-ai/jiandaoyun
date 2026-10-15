<script setup lang="ts">
import { computed, ref } from "vue";
import { useDialogLayer } from "../composables/useDialogLayer";
import AppIcon from "./AppIcon.vue";
import EditorDraftNotice from "./shared/EditorDraftNotice.vue";
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    width?: string;
    className?: string;
    draftKey?: string;
    busy?: boolean;
    pendingText?: string;
    modal?: boolean;
  }>(),
  { width: "520px", pendingText: "正在保存，请稍候…", modal: true },
);
const emit = defineEmits<{ close: []; closed: [] }>();
const blocked = computed(() => props.busy);
const dialog = ref<HTMLDialogElement>();
const { zIndex } = useDialogLayer(dialog, requestClose, () => emit("closed"), {
  modal: props.modal,
});
function requestClose() {
  if (!blocked.value) emit("close");
}
</script>
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-layer"
      :class="{ 'non-modal': !modal }"
      :style="{ zIndex }"
      @click.self="requestClose"
    >
      <dialog
        ref="dialog"
        open
        :aria-modal="modal || undefined"
        tabindex="-1"
        class="base-dialog"
        :class="[className, { 'has-editor-recovery': !!draftKey }]"
        :style="{ width }"
        :aria-label="title"
        :aria-busy="blocked"
        @cancel.prevent="requestClose"
      >
        <header class="dialog-header">
          <slot name="header"
            ><h2>{{ title }}</h2></slot
          >
          <button
            type="button"
            class="icon-button"
            title="关闭"
            aria-label="关闭"
            :disabled="blocked"
            @click="requestClose"
          >
            <AppIcon name="close" :size="20" />
          </button>
        </header>
        <p v-if="blocked" class="dialog-pending" role="status">
          <span class="visually-hidden">{{ pendingText }}</span>
        </p>
        <EditorDraftNotice
          v-if="open && draftKey"
          :draft-key="draftKey"
          :disabled="blocked"
        />
        <div class="dialog-body" :inert="blocked || undefined"><slot /></div>
        <footer
          v-if="$slots.footer"
          class="dialog-footer"
          :inert="blocked || undefined"
        >
          <slot name="footer" />
        </footer>
      </dialog>
    </div>
  </Teleport>
</template>
