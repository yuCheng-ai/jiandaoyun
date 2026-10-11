<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ProcessView, RecordDetail } from "@platform/contracts";
import { platformApi } from "../../repositories/platformApi";
import BaseDialog from "../../components/BaseDialog.vue";
import RecordEditor from "../collaboration/RecordEditor.vue";
const props = defineProps<{ processId: string }>();
const emit = defineEmits<{ close: []; updated: [] }>();
const process = ref<ProcessView>(), detail = ref<RecordDetail>(), busy = ref(false), error = ref(""), notice = ref("");
const labels = { waiting: "等待中", ready: "待处理", blocked: "需要处理", completed: "已完成" };
async function run(action: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ""; notice.value = ""; try { await action(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = false; } }
async function load() { process.value = await platformApi<ProcessView>(`/processes/${props.processId}`); emit("updated"); }
async function open(task: ProcessView["tasks"][number]) { await run(async () => { detail.value = await platformApi<RecordDetail>(`/processes/${props.processId}/tasks/${task.id}/record`); }); }
async function complete(task: ProcessView["tasks"][number]) { await run(async () => { process.value = await platformApi<ProcessView>(`/processes/${props.processId}/tasks/${task.id}/complete`, "POST", {}); notice.value = "任务已完成。"; emit("updated"); }); }
onMounted(() => run(load));
</script>
<template>
  <BaseDialog :open="true" :title="process?.title || '流程进度'" width="960px" :busy="busy" @close="emit('close')">
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p><p v-if="notice" class="collab-success" role="status">{{ notice }}</p>
    <template v-if="process"><div class="collab-toolbar"><div><strong>{{ process.status === 'completed' ? '流程已完成' : '流程进行中' }}</strong><p class="collab-help">已完成 {{ process.summary?.completed || 0 }} / {{ process.summary?.total || process.tasks.length }} 项任务<span v-if="process.templateVersion"> · 发起版本 V{{ process.templateVersion }}</span></p></div><button class="button" @click="run(load)">重新检查条件</button></div>
      <p class="collab-help">等待条件会自动检查；本页显示上次读取的结果。成员只查看分配给自己的任务。</p><p v-if="process.refreshError" class="collab-error" role="alert">{{ process.refreshError }}</p>
      <div class="collab-table-wrap"><table class="collab-table"><thead><tr><th>任务</th><th>处理人</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="task in process.tasks" :key="task.id"><td>{{ task.title }}<small v-if="task.rowId" class="process-subtitle">指定明细行</small></td><td>{{ task.assigneeName }}</td><td><span :class="['process-status',task.status]">{{ labels[task.status] }}</span><small v-if="task.reason" class="process-subtitle">{{ task.reason }}</small></td><td><div class="process-actions"><button class="text-button" @click="open(task)">{{ task.status === 'ready' ? '处理任务' : '查看记录' }}</button><button v-if="task.status === 'ready'" class="text-button" @click="complete(task)">完成任务</button></div></td></tr></tbody></table></div>
      <details class="process-history" open><summary>处理轨迹</summary><ol v-if="process.events?.length"><li v-for="event in process.events" :key="event.id"><time>{{ new Date(event.createdAt).toLocaleString('zh-CN') }}</time><span>{{ event.taskTitle ? `${event.taskTitle}：` : '' }}{{ event.detail }}{{ event.actorName ? ` · ${event.actorName}` : '' }}</span></li></ol><p v-else class="collab-help">暂无轨迹。</p></details>
    </template>
    <template #footer><button v-if="!process" class="button" @click="run(load)">重试</button><button class="button" @click="emit('close')">关闭</button></template>
  </BaseDialog>
  <RecordEditor v-if="detail" :published="detail" :detail="detail" @close="detail = undefined" @saved="async () => { detail = undefined; await run(async () => { await load(); notice = '业务数据已保存，可继续完成任务。' }) }" />
</template>
