<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { RecordDetail, RecordUpgradePlan } from "@platform/contracts";
import { platformApi } from "../../repositories/platformApi";
import BaseDialog from "../../components/BaseDialog.vue";
const props = defineProps<{ pageId: string; pageVersion: number; recordId: string }>();
const emit = defineEmits<{ close: []; updated: [record: RecordDetail] }>();
const plan = ref<RecordUpgradePlan>(), busy = ref(false), error = ref("");
let requestId = crypto.randomUUID();
const path = `/pages/${props.pageId}/records/${props.recordId}/upgrade`;
async function load() {
  busy.value = true; error.value = "";
  try { plan.value = await platformApi<RecordUpgradePlan>(`${path}?version=${props.pageVersion}`); requestId = crypto.randomUUID(); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function upgrade() {
  if (!plan.value?.allowed || busy.value) return;
  busy.value = true; error.value = "";
  try {
    emit("updated", await platformApi<RecordDetail>(path, "POST", { pageVersion: props.pageVersion, expectedRevision: plan.value.revision, defaultsToken: plan.value.defaultsToken, requestId }));
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <BaseDialog :open="true" title="更新记录数据版本" width="600px" :busy="busy" @close="emit('close')">
    <p v-if="busy" role="status">正在处理…</p><p v-if="error" class="collab-error" role="alert">{{ error }} <button class="text-button" @click="load">重新检查</button></p>
    <template v-if="plan"><p>这条记录将从 V{{ plan.fromVersion }} 更新到 V{{ plan.toVersion }}，用于当前页面。</p>
      <p v-if="!plan.allowed" class="collab-error" role="alert">{{ plan.reason }}</p>
      <table v-if="plan.additions.length" class="collab-table"><thead><tr><th>新增字段</th><th>初始值</th></tr></thead><tbody><tr v-for="item in plan.additions" :key="item.fieldId"><td>{{ item.parentName ? `${item.parentName} / ` : '' }}{{ item.name }}</td><td>{{ item.defaultDisplay ?? (Array.isArray(item.defaultValue) ? '暂无明细' : item.defaultValue === '' || item.defaultValue == null ? '待填写' : item.defaultValue) }}</td></tr></tbody></table>
      <p class="collab-help">保留原有内容和明细行身份，并记录本次更新前的快照。兼容的旧页面仍可处理原有字段。新字段沿用当前授权；更新后再按本页要求补充内容。</p>
    </template>
    <template #footer><button class="button" @click="emit('close')">暂不更新</button><button class="button primary" :disabled="!plan?.allowed || busy" @click="upgrade">更新并打开记录</button></template>
  </BaseDialog>
</template>
