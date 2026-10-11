<script setup lang="ts">
import AppIcon from "../AppIcon.vue";
withDefaults(
  defineProps<{
    message: string;
    canContinue: boolean;
    mode: "inline" | "page";
    preview?: boolean;
  }>(),
  { preview: false },
);
const emit = defineEmits<{ continue: [] }>();
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
      <p v-if="mode === 'page'">你的填写内容已保存。</p>
    </div>
    <button
      v-if="canContinue"
      class="button"
      :class="{ primary: mode === 'page' }"
      type="button"
      :disabled="preview"
      @click="emit('continue')"
    >
      继续填写
    </button>
  </section>
</template>
