<script setup lang="ts">
import BaseDialog from "../../components/BaseDialog.vue";
defineProps<{ embedded?: boolean; title: string; busy: boolean }>();
defineEmits<{ close: [] }>();
</script>
<template>
  <section v-if="embedded" class="record-editor-inline" :aria-busy="busy">
    <p v-if="busy" class="dialog-pending" role="status">
      <span class="visually-hidden">正在处理，请稍候…</span>
    </p>
    <div class="record-editor-content" :inert="busy || undefined"><slot /></div>
    <footer
      v-if="$slots.footer"
      class="runtime-footer"
      :inert="busy || undefined"
    >
      <slot name="footer" />
    </footer>
  </section>
  <BaseDialog
    v-else
    :open="true"
    :title="title"
    width="820px"
    :busy="busy"
    pending-text="正在处理，请稍候…"
    @close="$emit('close')"
    ><slot /><template v-if="$slots.footer" #footer
      ><slot name="footer" /></template
  ></BaseDialog>
</template>
<style scoped>
.record-editor-inline {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.record-editor-content {
  flex: 1;
  overflow: auto;
  padding: 24px;
}
.runtime-footer {
  display: flex;
  gap: 10px;
  padding: 10px 24px;
  border-top: 1px dashed #e1e5ef;
}
</style>
