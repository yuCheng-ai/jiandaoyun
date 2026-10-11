<script setup lang="ts">
import { ref } from "vue";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import AppIcon from "../../../components/AppIcon.vue";
import FormRuntime from "./FormRuntime.vue";
import type { FormSchema } from "../../../domain/form";
defineProps<{ schema: FormSchema; formId: string; title: string }>();
const emit = defineEmits<{ close: [] }>();
const device = ref<"desktop" | "mobile">("desktop");
const dialog = ref<HTMLDialogElement>();
const { zIndex } = useDialogLayer(dialog, () => emit("close"));
</script>
<template>
  <Teleport to="body">
    <div
      class="dialog-layer form-preview-layer"
      :style="{ zIndex }"
      @click.self="emit('close')"
    >
      <dialog
        ref="dialog"
        open
        aria-modal="true"
        tabindex="-1"
        class="form-preview-dialog"
        aria-label="表单预览"
        @cancel.prevent="emit('close')"
      >
        <header>
          <div class="segmented device-tabs">
            <button
              aria-label="电脑预览"
              :class="{ active: device === 'desktop' }"
              @click="device = 'desktop'"
            >
              <AppIcon name="desktop" :size="20" /></button
            ><button
              aria-label="手机预览"
              :class="{ active: device === 'mobile' }"
              @click="device = 'mobile'"
            >
              <AppIcon name="phone" :size="20" />
            </button>
          </div>
          <button
            class="icon-button"
            aria-label="关闭预览"
            @click="emit('close')"
          >
            <AppIcon name="close" :size="22" />
          </button>
        </header>
        <div class="form-preview-body">
          <div
            class="form-preview-sheet"
            :class="{ mobile: device === 'mobile' }"
          >
            <FormRuntime
              :key="formId"
              :schema="schema"
              :form-id="formId"
              :device="device"
            />
          </div>
        </div>
      </dialog>
    </div>
  </Teleport>
</template>
