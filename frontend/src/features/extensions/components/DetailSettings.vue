<script setup lang="ts">
import { watch, computed } from "vue";
import type { FormRecord } from "../../../domain/workspace";
import { defaultDetailSettings } from "../../../domain/presentation";
import { sampleValues } from "../../../domain/extensions";
import RecordBody from "../../forms/components/RecordBody.vue";
import PresentationFields from "./PresentationFields.vue";
const props = defineProps<{ form: FormRecord }>();
const settings = computed(() => props.form.extensions!.detail!);
watch(
  () => props.form,
  (form) => {
    form.extensions ||= { webhooks: [] };
    form.extensions.detail ||= defaultDetailSettings();
  },
  { immediate: true },
);
const values = computed(() => sampleValues(props.form.schema));
</script>
<template>
  <div class="submission-settings">
    <section class="submission-controls">
      <h3>为查看记录的人安排内容</h3>
      <label class="config-label"
        >展示范围<select v-model="settings.fieldMode">
          <option value="all">全部字段，随表单顺序</option>
          <option value="custom">指定字段和顺序</option>
        </select></label
      ><PresentationFields
        include-lookup
        v-if="settings.fieldMode === 'custom'"
        v-model="settings.fieldIds"
        :schema="form.schema"
      /><label class="config-label"
        >字段布局<select v-model.number="settings.columns">
          <option :value="1">单列</option>
          <option :value="2">双列</option>
        </select></label
      >
      <div class="presentation-checks">
        <label
          ><input
            type="checkbox"
            v-model="settings.hideEmpty"
          />隐藏未填写字段</label
        ><label
          ><input
            type="checkbox"
            v-model="settings.showMetadata"
          />显示记录信息</label
        ><label
          ><input
            type="checkbox"
            v-model="settings.showHistory"
          />显示操作记录</label
        >
      </div>
      <p class="field-hint">
        调整详情的展示，不修改原始记录。记录沿用提交时的布局版本。
      </p>
      <div class="submission-save">
        <span>发布后用于新记录</span
        ><button class="button primary" disabled>保存详情布局</button>
      </div>
    </section>
    <aside class="submission-preview detail-preview">
      <span class="eyebrow">数据详情 · 示例预览</span>
      <div v-if="settings.showMetadata" class="detail-preview-meta">
        示例记录 · 创建时间 · 表单版本
      </div>
      <RecordBody :schema="form.schema" :values="values" :settings="settings" />
      <div v-if="settings.showHistory" class="detail-preview-meta">
        流程动态将显示在此处
      </div>
    </aside>
  </div>
</template>
