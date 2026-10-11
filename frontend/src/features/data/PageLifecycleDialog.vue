<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { PageDraft, PageLifecycleImpact, PageSummary } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { platformApi } from "../../repositories/platformApi";
const props = defineProps<{ page: PageSummary; action: "archive" | "restore" }>();
const emit = defineEmits<{ close: []; saved: [page: PageDraft] }>();
const impact = ref<PageLifecycleImpact>(), busy = ref(false), error = ref("");
async function check() {
  if (busy.value) return;
  busy.value = true; error.value = ""; impact.value = undefined;
  try {
    const current = await platformApi<PageDraft>(`/pages/${props.page.id}/draft`);
    impact.value = await platformApi<PageLifecycleImpact>(`/pages/${props.page.id}/lifecycle-preview`, "POST", { action: props.action, expectedRevision: current.revision });
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function confirm() {
  if (!impact.value || busy.value || error.value) return;
  busy.value = true; error.value = "";
  try { emit("saved", await platformApi<PageDraft>(`/pages/${props.page.id}/${props.action}`, "POST", { expectedRevision: impact.value.revision, impactToken: impact.value.token })); }
  catch (cause) { error.value = (cause as Error).message; impact.value = undefined; }
  finally { busy.value = false; }
}
onMounted(check);
</script>
<template>
  <BaseDialog :open="true" :title="action === 'archive' ? '归档页面' : '恢复页面'" width="720px" :busy="busy" @close="emit('close')">
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <template v-if="impact">
      <p v-if="action === 'archive'">归档「{{ impact.title }}」后，普通页面入口将收起，新流程不能再使用它。已经发出的任务仍可从待办按原页面版本处理。</p>
      <p v-else>恢复「{{ impact.title }}」后，原页面入口重新可用，流程可再次选择它。页面版本、字段绑定和草稿沿用归档前的内容。</p>
      <p class="collab-help">{{ impact.publishedVersion ? `保留已发布页面 V${impact.publishedVersion}` : '此页面尚未发布' }}，以及 {{ impact.pendingFieldCount }} 个待发布新字段。共享数据和业务记录保持原样。</p>
      <p v-for="warning in impact.warnings" :key="warning" class="collab-notice">{{ warning }}</p>
      <section class="page-lifecycle-section"><h3>已有任务</h3><p v-for="item in impact.tasks" :key="item.version">页面 V{{ item.version }}：{{ item.active }} 个未完成任务，{{ item.completed }} 个已完成任务。</p><p v-if="!impact.tasks.length" class="collab-help">暂无已发任务使用此页面。</p></section>
      <section class="page-lifecycle-section"><h3>流程使用情况</h3><ul><li v-for="(item, index) in impact.references" :key="index"><strong>{{ item.title }}</strong> · {{ item.state === 'draft' ? '草稿' : `已发布 V${item.version}` }}<p class="collab-help">{{ item.tasks.map(task => `${task.title}：页面 V${task.pageVersion}`).join('；') }}</p></li></ul><p v-if="!impact.references.length" class="collab-help">暂无流程配置引用此页面。</p></section>
    </template>
    <p v-else-if="busy" role="status">正在检查页面和使用情况…</p>
    <template #footer><button class="button" :disabled="busy" @click="emit('close')">取消</button><button v-if="error || !impact" class="button" :disabled="busy" @click="check">重新检查</button><button class="button primary" :disabled="busy || !impact || !!error" @click="confirm">{{ action === 'archive' ? '确认归档页面' : '确认恢复页面' }}</button></template>
  </BaseDialog>
</template>
<style scoped>
.page-lifecycle-section { border-top: 1px solid #e2e7ef; padding-top: 12px; margin-top: 16px; }
.page-lifecycle-section h3 { margin: 0 0 8px; font-size: 14px; }
.page-lifecycle-section ul { padding-left: 20px; line-height: 1.6; }
.page-lifecycle-section p { overflow-wrap: anywhere; }
</style>
