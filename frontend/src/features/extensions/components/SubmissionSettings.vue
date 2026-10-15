<script setup lang="ts">
import type { FormSchema } from "../../../domain/form";
import SubmissionReceipt from "../../../components/shared/SubmissionReceipt.vue";
defineProps<{
  schema: FormSchema;
  dirty: boolean;
  busy?: boolean;
  error?: string;
}>();
const emit = defineEmits<{ save: [] }>();
</script>
<template>
  <div class="submission-settings" :inert="busy">
    <section class="submission-controls">
      <h3>提交成功后，告诉填写者什么？</h3>
      <label class="config-label"
        >成功提示<textarea
          v-model="schema.settings.successMessage"
          maxlength="100"
          rows="3"
          placeholder="提交成功"
        />
      </label>
      <span class="field-hint"
        >{{ schema.settings.successMessage.length }} / 100 ·
        发布新版本后生效</span
      >
      <label class="receipt-repeat"
        ><input
          type="checkbox"
          v-model="schema.settings.allowAnotherSubmission"
        />显示“继续填写”按钮</label
      >
      <p class="field-hint">
        点击后清空本次填写，按默认值开始新一条记录。隐藏按钮只影响此页面的入口。
      </p>
      <div class="submission-save">
        <span>{{ dirty ? "有未保存的设置" : "设置已保存到设计草稿" }}</span>
        <button
          class="button primary"
          :disabled="busy || !dirty"
          @click="emit('save')"
        >
          {{ busy ? "保存中…" : "保存设置" }}
        </button>
      </div>
      <p v-if="error" class="config-warning" role="alert">{{ error }}</p>
    </section>
    <aside class="submission-preview">
      <span class="eyebrow">填写者看到的效果</span
      ><SubmissionReceipt
        :message="schema.settings.successMessage"
        :can-continue="schema.settings.allowAnotherSubmission"
        preview
      />
      <p class="field-hint">
        这里只预览效果，不会提交记录。发布新版本后应用到正式填写页。
      </p>
    </aside>
  </div>
</template>
