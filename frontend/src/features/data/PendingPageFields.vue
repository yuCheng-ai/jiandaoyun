<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { PendingPageFields } from "@platform/contracts";
import { platformApi } from "../../repositories/platformApi";
const props = defineProps<{ definitionId: string; applicationId: string; revision: number }>();
const result = ref<PendingPageFields>(), busy = ref(false), error = ref("");
let request = 0;
async function refresh() {
  const current = ++request, id = props.definitionId;
  busy.value = true; error.value = ""; result.value = undefined;
  try {
    const response = await platformApi<PendingPageFields>(`/data-objects/${id}/pending-page-fields`);
    if (current === request) result.value = response;
  } catch (cause) { if (current === request) error.value = (cause as Error).message; }
  finally { if (current === request) busy.value = false; }
}
watch(() => [props.definitionId, props.revision], refresh, { immediate: true });
onBeforeUnmount(() => request++);
const location = (id: string, fieldId?: string) => ({ path: `/applications/${props.applicationId}/pages/${id}/design`, query: fieldId ? { field: fieldId } : {} });
</script>
<template>
  <section class="pending-page-fields" aria-label="页面待发布字段" :aria-busy="busy">
    <div class="collab-toolbar"><h3>页面待发布字段</h3><button class="text-button" :disabled="busy" @click="refresh">刷新待发布字段</button></div>
    <p class="collab-help">显示各页面已保存的新字段，随来源页面发布后加入共享数据。尚未保存的输入只保留在编辑页面中。</p>
    <p v-if="busy" class="collab-help" role="status">正在读取页面草稿…</p>
    <p v-else-if="error" class="collab-error" role="alert">{{ error }}<button class="text-button" @click="refresh">重试</button></p>
    <template v-else-if="result">
      <article v-for="page in result.pages" :key="page.id" class="pending-page-card">
        <div class="collab-toolbar"><strong>{{ page.title }}{{ page.archivedAt ? ' · 已归档' : '' }}</strong><RouterLink class="text-button" :to="location(page.id)">进入来源页面</RouterLink></div>
        <ul class="pending-fields-list"><li v-for="field in page.fields" :key="field.id"><RouterLink :to="location(page.id, field.id)">{{ field.name }}</RouterLink><span>{{ field.parentName ? `${field.parentName} · 明细列` : field.kind === 'subform' ? '新增明细' : '主字段' }}</span></li></ul>
        <p v-for="warning in page.warnings" :key="warning" class="pending-fields-warning">{{ warning }}</p>
      </article>
      <p v-if="!result.pages.length" class="collab-help">没有已保存的页面新增字段。</p>
    </template>
  </section>
</template>
<style scoped>
.pending-page-fields { border-top: 1px solid #e2e7ef; margin-top: 22px; padding-top: 16px; }
.pending-page-fields h3 { margin: 0; font-size: 14px; }
.pending-page-card { margin-top: 12px; border: 1px solid #e2e7ef; border-radius: 6px; padding: 12px; }
.pending-page-card strong { overflow-wrap: anywhere; }
.pending-fields-list { list-style: none; padding: 0; margin: 8px 0 0; }
.pending-fields-list li { display: flex; gap: 12px; justify-content: space-between; padding: 6px 0; font-size: 12px; }
.pending-fields-list a { min-width: 0; overflow-wrap: anywhere; color: #327dda; }
.pending-fields-list span { color: #718098; text-align: right; overflow-wrap: anywhere; }
.pending-fields-warning { color: #90601f; background: #fff7e8; padding: 8px; margin: 8px 0 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
