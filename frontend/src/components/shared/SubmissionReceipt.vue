<script setup lang="ts">
import AppIcon from "../AppIcon.vue";
withDefaults(
  defineProps<{
    message: string;
    canContinue: boolean;
    mode: "inline" | "page";
    processId?: string;
    preview?: boolean;
  }>(),
  { preview: false },
);
const emit = defineEmits<{ continue: []; viewProcess: [id: string] }>();
</script>
<template>
  <section
    class="submission-receipt"
    :class="mode"
    :aria-live="preview ? 'off' : 'polite'"
    aria-label="提交结果"
  >
    <AppIcon name="success" :size="mode === 'page' ? 48 : 20" />
    <div>
      <h2>{{ message.trim() || "提交成功" }}</h2>
      <p v-if="processId">流程已发起。</p>
      <p v-else-if="mode === 'page'">你的填写内容已保存。</p>
    </div>
    <button
      v-if="processId"
      class="button primary"
      type="button"
      :disabled="preview"
      @click="emit('viewProcess', processId)"
    >
      查看申请
    </button>
    <button
      v-if="canContinue"
      class="button"
      :class="{ primary: mode === 'page' && !processId }"
      type="button"
      :disabled="preview"
      @click="emit('continue')"
    >
      继续填写
    </button>
  </section>
</template>

<style scoped>
.submission-receipt {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #219c89;
  padding: 20px;
}
.submission-receipt h2 {
  font-size: 16px;
  font-weight: 500;
  margin: 0;
  overflow-wrap: anywhere;
  line-height: 1.8;
}
.submission-receipt p {
  font-size: 13px;
  color: #8693a0;
  margin: 10px 0 26px;
}
.submission-receipt.page {
  flex-direction: column;
  text-align: center;
  justify-content: center;
  min-height: 300px;
  background: white;
  border-radius: 6px;
}
.submission-receipt.inline {
  background: #eef8f4;
  border-radius: 5px;
  flex-wrap: wrap;
}
.submission-receipt.inline > div {
  flex: 1;
  min-width: 160px;
}
.submission-receipt.inline h2 {
  font-size: 13px;
}
.submission-receipt.inline p {
  margin: 4px 0 0;
}
.submission-receipt > .button:disabled {
  opacity: 0.7;
  cursor: default;
}
</style>
