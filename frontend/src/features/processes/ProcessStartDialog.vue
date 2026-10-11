<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { ProcessStartPreview, ProcessView, PublishedProcessTemplate } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { platformApi, PlatformError } from "../../repositories/platformApi";
const props = defineProps<{ templateId: string; version: number }>();
const emit = defineEmits<{ close: []; started: [id: string] }>();
const template = ref<PublishedProcessTemplate>(), choices = ref<Record<string, { id: string; label: string; definitionVersion: number; createdAt: string }[]>>({});
const bindings = ref<Record<string, string>>({}), preview = ref<ProcessStartPreview>(), busy = ref(false), error = ref('');
const path = `/process-templates/${props.templateId}/versions/${props.version}`;
let requestKey = '', requestFingerprint = '';
watch(bindings, () => { preview.value = undefined; error.value = ''; }, { deep: true });
async function run(action: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; try { await action(); } catch (cause) { error.value = (cause as Error).message; if (cause instanceof PlatformError && cause.status === 409) preview.value = undefined; } finally { busy.value = false; } }
async function load() { template.value = await platformApi<PublishedProcessTemplate>(path); choices.value = Object.fromEntries(await Promise.all(template.value.spec.bindings.map(async b => [b.id, await platformApi(`${path}/records?bindingId=${b.id}`)]))); }
onMounted(() => run(load));
async function inspect() { await run(async () => { if (template.value!.spec.bindings.some(b => !bindings.value[b.id])) throw new Error('请选择每份业务数据对应的记录。'); preview.value = await platformApi<ProcessStartPreview>(`${path}/preview`, 'POST', { bindings: bindings.value }); }); }
async function start() { if (!preview.value) return; await run(async () => {
  const payload = { bindings: preview.value!.bindings, recordRevisions: preview.value!.recordRevisions, ...(preview.value!.participantsToken ? { participantsToken: preview.value!.participantsToken } : {}) }, fingerprint = JSON.stringify(payload);
  if (fingerprint !== requestFingerprint) { requestFingerprint = fingerprint; requestKey = crypto.randomUUID(); }
  const result = await platformApi<ProcessView>(`${path}/start`, 'POST', { ...payload, requestId: requestKey }); emit('started', result.id);
}); }
</script>
<template>
  <BaseDialog :open="true" :title="`发起流程${template ? ` · ${template.spec.title}` : ''}`" width="860px" :busy="busy" @close="emit('close')">
    <p class="collab-help">使用已发布 V{{ version }}。先选择记录，再确认处理人、页面和明细任务。</p>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <label v-for="b in template?.spec.bindings" :key="b.id" class="collab-field">{{ b.title }}<select v-model="bindings[b.id]" :aria-label="`选择${b.title}记录`"><option :value="undefined">请选择记录</option><option v-for="record in choices[b.id] || []" :key="record.id" :value="record.id">{{ record.label }} · {{ new Date(record.createdAt).toLocaleString('zh-CN') }} · V{{ record.definitionVersion }}</option></select><small v-if="!choices[b.id]?.length">暂无兼容记录，请先从对应表单页面创建。</small></label>
    <p class="collab-help">展示最近 100 条记录中的兼容记录；发起前会检查处理人的当前权限。</p><button class="text-button" @click="run(load)">刷新可选记录</button>
    <div v-if="preview" class="process-preview"><strong>本次生成 {{ preview.tasks.length }} 项任务</strong><div class="collab-table-wrap"><table class="collab-table"><thead><tr><th>任务</th><th>处理人</th><th>处理页面</th><th>前置任务</th></tr></thead><tbody><tr v-for="task in preview.tasks" :key="task.key"><td>{{ task.title }}</td><td>{{ task.assigneeName }}</td><td>{{ task.pageTitle }}</td><td>{{ task.dependsOn.length ? `等待 ${task.dependsOn.length} 项完成` : '无前置任务' }}</td></tr></tbody></table></div><p class="collab-help">还需满足已配置的业务等待条件。部门/角色会为每位成员生成任务，前置节点全部完成才继续。明细和处理人以当前预览为准，确认前记录或组织发生变化时需要重新预览。</p></div>
    <template #footer><button class="button" @click="emit('close')">取消</button><button v-if="!template" class="button" @click="run(load)">重试</button><button class="button" :disabled="!template" @click="inspect">{{ preview ? '重新预览' : '预览任务' }}</button><button class="button primary" :disabled="!preview" @click="start">确认发起</button></template>
  </BaseDialog>
</template>
