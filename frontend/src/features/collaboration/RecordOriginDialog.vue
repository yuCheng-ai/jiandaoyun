<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { legacyRecordStatusLabel, type RecordOrigin } from '@platform/contracts';
import BaseDialog from '../../components/BaseDialog.vue';
import { platformApi } from '../../repositories/platformApi';
const props = defineProps<{ recordId: string }>();
const emit = defineEmits<{ close: [] }>();
const origin = ref<RecordOrigin>(), busy = ref(false), error = ref('');
async function load() {
  busy.value = true; error.value = '';
  try { origin.value = await platformApi<RecordOrigin>(`/records/${props.recordId}/origin`); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <BaseDialog :open="true" title="原始记录与处理轨迹" width="760px" :busy="busy" @close="emit('close')">
    <p class="collab-help">以下内容保留迁移来源中的原始状态和处理顺序。后续修改不改写本档案，原审批结果不代表在当前系统重新执行了流程。</p>
    <p v-if="busy" role="status">正在读取原始记录…</p>
    <p v-if="error" class="collab-error" role="alert">{{ error }} <button class="text-button" @click="load">重新读取</button></p>
    <template v-if="origin">
      <dl class="origin-summary">
        <dt>原应用 / 表单</dt><dd>{{ origin.sourceApplicationName }} / {{ origin.sourceFormName }} · V{{ origin.sourceVersion }}</dd>
        <dt>原状态</dt><dd>{{ legacyRecordStatusLabel(origin.status) }}{{ origin.deletedAt ? '（原记录已删除）' : '' }}</dd>
        <dt>原创建者</dt><dd>{{ origin.sourceCreatorName }}</dd>
        <dt>原创建部门</dt><dd>{{ origin.sourceDepartments === null ? '原记录未留存' : origin.sourceDepartments.map(item => item.name).join('、') || '创建时无所属部门' }}</dd>
        <dt>原创建时间</dt><dd>{{ origin.createdAt }}</dd>
        <template v-if="origin.updatedAt"><dt>原修改时间</dt><dd>{{ origin.updatedAt }}</dd></template>
        <template v-if="origin.deletedAt"><dt>原删除时间</dt><dd>{{ origin.deletedAt }}</dd></template>
        <template v-if="origin.currentNodeId"><dt>原处理节点</dt><dd>{{ origin.currentNodeId }}（保留来源记录，未据此生成新待办）</dd></template>
      </dl>
      <h3>原处理轨迹</h3>
      <ol v-if="origin.history.length" class="origin-history"><li v-for="(item, index) in origin.history" :key="index"><strong>{{ item.label }}</strong><p>{{ item.action }}</p><time>{{ item.time }}</time></li></ol>
      <p v-else class="collab-help">原记录没有处理轨迹。</p>
    </template>
    <template #footer><button class="button" @click="emit('close')">关闭</button></template>
  </BaseDialog>
</template>
<style scoped>
.origin-summary { display:grid; grid-template-columns:110px minmax(0,1fr); gap:10px; font-size:13px; }
.origin-summary dt { color:#687280; }.origin-summary dd { margin:0; overflow-wrap:anywhere; }
.origin-history { padding-left:24px; }.origin-history li { padding:8px 0; font-size:13px; overflow-wrap:anywhere; }.origin-history p { white-space:pre-wrap; margin:6px 0; }.origin-history time { color:#687280; font-size:12px; }
@media(max-width:600px) { .origin-summary { grid-template-columns:90px minmax(0,1fr); } }
</style>
