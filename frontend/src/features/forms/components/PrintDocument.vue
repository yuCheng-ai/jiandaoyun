<script setup lang="ts">
import type { PrintTemplate } from "../../../domain/presentation";
import type { FormSchema, FormValues } from "../../../domain/form";
import type { FormEntry } from "../../../domain/workspace";
import RecordBody from "./RecordBody.vue";
defineProps<{
  template: PrintTemplate;
  schema: FormSchema;
  values: FormValues;
  title: string;
  entry?: FormEntry;
}>();
</script>
<template>
  <article
    class="print-paper"
    :class="template.orientation"
    :style="{ fontSize: `${template.fontSize}px` }"
  >
    <header class="print-heading">
      <h1>{{ template.title || title }}</h1>
      <p v-if="template.subtitle">{{ template.subtitle }}</p>
    </header>
    <dl v-if="template.showMetadata" class="record-meta">
      <div>
        <dt>记录编号</dt>
        <dd>{{ entry?.id || "预览示例" }}</dd>
      </div>
      <div>
        <dt>创建时间</dt>
        <dd>
          {{
            entry
              ? new Date(entry.createdAt).toLocaleString("zh-CN")
              : "以实际创建时间为准"
          }}
        </dd>
      </div>
      <div v-if="entry">
        <dt>表单版本</dt>
        <dd>V{{ entry.definitionVersion }}</dd>
      </div>
    </dl>
    <RecordBody
      :schema="schema"
      :values="values"
      :settings="template"
      :entry-id="entry?.id"
    />
    <section
      v-if="template.showHistory && entry?.history.length"
      class="print-history"
    >
      <h3>操作记录</h3>
      <p v-for="(item, index) in entry.history" :key="index">
        {{ item.label }} · {{ item.action }}
        <small>{{ new Date(item.time).toLocaleString("zh-CN") }}</small>
      </p>
    </section>
    <footer v-if="template.footer" class="print-footnote">
      {{ template.footer }}
    </footer>
  </article>
</template>
