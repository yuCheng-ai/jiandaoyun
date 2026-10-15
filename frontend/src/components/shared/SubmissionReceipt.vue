<script setup lang="ts">
import { onMounted, ref } from "vue";
import AppIcon from "../AppIcon.vue";
const props = withDefaults(
  defineProps<{
    message: string;
    canContinue: boolean;
    processId?: string;
    preview?: boolean;
  }>(),
  { preview: false },
);
const emit = defineEmits<{ continue: []; viewProcess: [id: string] }>();
const result = ref<HTMLElement>();
onMounted(() => {
  // 提交按钮随表单卸载后，把键盘焦点和长表单的滚动位置带到提交结果。
  if (!props.preview) result.value?.focus();
});
</script>
<template>
  <section
    ref="result"
    class="submission-receipt"
    :tabindex="preview ? undefined : -1"
    :aria-live="preview ? 'off' : 'polite'"
    aria-label="提交结果"
  >
    <AppIcon name="success" :size="48" />
    <div>
      <h2>{{ message.trim() || "提交成功" }}</h2>
      <p v-if="processId">流程已发起。</p>
      <p v-else>你的填写内容已保存。</p>
    </div>
    <div v-if="processId || canContinue" class="submission-actions">
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
        :class="{ primary: !processId }"
        type="button"
        :disabled="preview"
        @click="emit('continue')"
      >
        继续填写
      </button>
    </div>
  </section>
</template>

<style scoped>
.submission-receipt {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  min-height: 360px;
  padding: 48px 20px;
  text-align: center;
  color: var(--teal);
  outline: none;
}
.submission-receipt h2 {
  font-size: 20px;
  font-weight: 600;
  color: #202938;
  margin: 0;
  overflow-wrap: anywhere;
  line-height: 1.8;
}
.submission-receipt p {
  font-size: 13px;
  color: var(--muted);
  margin: 8px 0 0;
}
.submission-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 4px;
}
.submission-actions .button {
  min-width: 108px;
}
.submission-actions .button:disabled {
  opacity: 0.7;
  cursor: default;
}
</style>
