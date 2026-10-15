<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ProcessView, RecordDetail } from "@platform/contracts";
import { platformApi, PlatformError } from "../../repositories/platformApi";
import { useNotices } from "../../stores/notices";
import BaseDialog from "../../components/BaseDialog.vue";
import RecordEditor from "../collaboration/RecordEditor.vue";
import "./processes.css";

const props = defineProps<{ processId: string }>();
const emit = defineEmits<{ close: []; updated: [] }>();
const process = ref<ProcessView>();
const detail = ref<RecordDetail>();
const editor = ref<InstanceType<typeof RecordEditor>>();
const busy = ref(false);
const submitting = ref(false);
const error = ref("");
const recordError = ref("");
const { notify } = useNotices();
const delegation = ref<ProcessView["tasks"][number]>();
const recipients = ref<{ id: string; name: string }[]>([]);
const recipientId = ref("");
const delegateError = ref("");
const locked = computed(
  () => busy.value || submitting.value || !!editor.value?.busy,
);
const currentTask = computed(() =>
  process.value?.tasks.find((task) => task.id === detail.value?.task?.taskId),
);
const canHandle = computed(
  () => !!currentTask.value?.canHandle && !!detail.value?.task?.writable,
);
const pendingTasks = computed(
  () =>
    process.value?.tasks.filter((task) => task.status !== "completed") || [],
);
// 处理记录只呈现人的操作；等待依赖、就绪计算等运行日志仍保留在服务端。
const history = computed(
  () =>
    process.value?.events?.filter((event) =>
      ["started", "completed", "record-saved", "delegated", "copied"].includes(
        event.action,
      ),
    ) || [],
);
const labels = {
  waiting: "待流转",
  ready: "待处理",
  blocked: "需要处理",
  completed: "已完成",
};
const eventLabels: Record<string, string> = {
  started: "发起申请",
  completed: "提交办理",
  "record-saved": "保存修改",
  delegated: "委托办理",
  copied: "抄送",
};

async function run(action: () => Promise<void>) {
  if (locked.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function loadRecord(taskId?: string) {
  detail.value = undefined;
  recordError.value = "";
  const path = taskId
    ? `/processes/${props.processId}/tasks/${taskId}/record`
    : `/processes/${props.processId}/record`;
  try {
    detail.value = await platformApi<RecordDetail>(path);
  } catch (cause) {
    recordError.value = (cause as Error).message;
  }
}
async function load() {
  process.value = await platformApi<ProcessView>(
    `/processes/${props.processId}`,
  );
  await loadRecord();
  emit("updated");
}
// 关闭、刷新和切换办理节点共用表单已有的未保存确认。
async function afterLeave(action: () => void | Promise<void>) {
  if (locked.value) return;
  if (editor.value) await editor.value.runAfterLeave(action);
  else await action();
}
function open(taskId: string) {
  void afterLeave(() => run(() => loadRecord(taskId)));
}
async function saved(record: RecordDetail) {
  detail.value = record;
  // 提交办理会统一刷新进度；单独保存只刷新轨迹，不再重读或清空表单。
  if (submitting.value) return;
  notify("已保存");
  busy.value = true;
  error.value = "";
  try {
    process.value = await platformApi<ProcessView>(
      `/processes/${props.processId}`,
    );
    emit("updated");
  } catch (cause) {
    error.value = `内容已保存，处理记录未能刷新：${(cause as Error).message}`;
  } finally {
    busy.value = false;
  }
}
async function complete() {
  const task = currentTask.value;
  if (locked.value || !task || !canHandle.value || !editor.value) return;
  submitting.value = true;
  error.value = "";
  try {
    // 先保存当前填写；保存失败保留输入，绝不直接推进流程。
    if (editor.value.dirty && !(await editor.value.save())) return;
    process.value = await platformApi<ProcessView>(
      `/processes/${props.processId}/tasks/${task.id}/complete`,
      "POST",
      {},
    );
    await loadRecord();
    notify("已提交办理");
    emit("updated");
  } catch (cause) {
    if (editor.value?.showValidation(cause)) return;
    if (
      cause instanceof PlatformError &&
      (cause.status === 0 || cause.status >= 500)
    ) {
      notify(cause.message, "error");
      return;
    }
    error.value = (cause as Error).message;
  } finally {
    submitting.value = false;
  }
}
async function chooseDelegate() {
  const task = currentTask.value;
  if (!task || !canHandle.value) return;
  await afterLeave(() =>
    run(async () => {
      recipients.value = await platformApi(
        `/processes/${props.processId}/tasks/${task.id}/delegate-options`,
      );
      recipientId.value = "";
      delegateError.value = "";
      delegation.value = task;
    }),
  );
}
async function delegate() {
  if (!delegation.value || !recipientId.value || locked.value) return;
  busy.value = true;
  delegateError.value = "";
  try {
    process.value = await platformApi<ProcessView>(
      `/processes/${props.processId}/tasks/${delegation.value.id}/delegate`,
      "POST",
      { assigneeId: recipientId.value },
    );
    delegation.value = undefined;
    await loadRecord();
    notify("待办已委托");
    emit("updated");
  } catch (cause) {
    delegateError.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(() => run(load));
</script>
<template>
  <BaseDialog
    :open="true"
    :title="process?.title || '申请详情'"
    width="1120px"
    class-name="process-detail"
    :busy="locked"
    pending-text="正在处理，请稍候…"
    @close="afterLeave(() => emit('close'))"
  >
    <template #header>
      <h2>{{ process?.title || "申请详情" }}</h2>
      <span
        v-if="process"
        :class="[
          'process-status',
          process.status === 'completed' ? 'completed' : 'ready',
        ]"
      >
        {{ process.status === "completed" ? "已完成" : "进行中" }}
      </span>
    </template>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <div v-if="process" class="process-detail-layout">
      <section class="process-detail-form" aria-label="申请内容">
        <div class="process-detail-heading">
          <strong>{{
            detail?.page?.title || detail?.definition.title || "申请内容"
          }}</strong>
          <span v-if="canHandle" class="collab-help"
            >当前办理：{{ currentTask?.title }}</span
          >
        </div>
        <div v-if="recordError" class="process-record-error" role="alert">
          <p>{{ recordError }}</p>
          <button class="button" @click="run(() => loadRecord())">
            重新读取
          </button>
        </div>
        <RecordEditor
          v-if="detail"
          :key="`${detail.record.id}:${detail.record.revision}:${detail.task?.taskId || 'application'}`"
          ref="editor"
          :published="detail"
          :detail="detail"
          embedded
          @saved="saved"
        >
          <template #footer-actions>
            <button
              v-if="canHandle"
              class="button"
              :disabled="locked"
              @click="chooseDelegate"
            >
              委托
            </button>
            <button
              v-if="canHandle"
              class="button primary"
              :disabled="locked"
              @click="complete"
            >
              提交办理
            </button>
            <button
              v-else
              class="button"
              :disabled="locked"
              @click="afterLeave(() => emit('close'))"
            >
              关闭
            </button>
          </template>
        </RecordEditor>
      </section>
      <aside class="process-detail-progress" aria-label="流程进度">
        <div class="process-detail-heading">
          <strong>流程进度</strong>
          <button
            class="text-button"
            :disabled="locked"
            @click="afterLeave(() => run(load))"
          >
            刷新
          </button>
        </div>
        <p v-if="process.refreshError" class="collab-error" role="alert">
          {{ process.refreshError }}
        </p>
        <div v-if="pendingTasks.length" class="process-current-tasks">
          <div
            v-for="task in pendingTasks"
            :key="task.id"
            class="process-current-task"
          >
            <div>
              <button
                v-if="task.canOpen && task.id !== currentTask?.id"
                class="text-button"
                @click="open(task.id)"
              >
                {{ task.title }}
              </button>
              <strong v-else>{{ task.title }}</strong>
              <span :class="['process-status', task.status]">{{
                labels[task.status]
              }}</span>
            </div>
            <p>{{ task.assigneeName }}</p>
            <p
              v-if="task.reason && task.status === 'blocked'"
              class="collab-error"
            >
              {{ task.reason }}
            </p>
          </div>
        </div>
        <h3>处理记录</h3>
        <ol v-if="history.length" class="process-timeline">
          <li v-for="event in history" :key="event.id">
            <div>
              <strong>{{ event.actorName || event.taskTitle || "系统" }}</strong
              ><span>{{ eventLabels[event.action] }}</span>
            </div>
            <p v-if="event.taskTitle && event.actorName">
              {{ event.taskTitle }}
            </p>
            <p v-if="event.action === 'delegated'">{{ event.detail }}</p>
            <time>{{ new Date(event.createdAt).toLocaleString("zh-CN") }}</time>
          </li>
          <li
            v-if="process.status === 'completed'"
            class="process-timeline-end"
          >
            流程结束
          </li>
        </ol>
        <p v-else class="collab-help">暂无处理记录</p>
        <details
          v-if="
            process.tasks.some(
              (task) => task.canOpen && task.status === 'completed',
            )
          "
          class="process-handled-views"
        >
          <summary>已处理节点</summary>
          <button
            v-for="task in process.tasks.filter(
              (item) => item.canOpen && item.status === 'completed',
            )"
            :key="task.id"
            class="text-button"
            @click="open(task.id)"
          >
            {{ task.title }} · {{ task.assigneeName }}
          </button>
        </details>
      </aside>
    </div>
    <button v-if="!process && error" class="button" @click="run(load)">
      重试
    </button>
  </BaseDialog>
  <BaseDialog
    :open="!!delegation"
    title="委托待办"
    :busy="busy"
    @close="delegation = undefined"
  >
    <p>将「{{ delegation?.title }}」交给其他成员接手。</p>
    <label class="collab-field"
      >接手成员<select v-model="recipientId">
        <option value="">请选择成员</option>
        <option v-for="user in recipients" :key="user.id" :value="user.id">
          {{ user.name }}
        </option>
      </select></label
    >
    <p v-if="!recipients.length" class="collab-help">
      暂无可接手的其他成员，请联系管理员检查表单权限。
    </p>
    <p v-if="delegateError" class="collab-error" role="alert">
      {{ delegateError }}
    </p>
    <template #footer>
      <button class="button" @click="delegation = undefined">取消</button>
      <button
        class="button primary"
        :disabled="busy || !recipientId"
        @click="delegate"
      >
        确认委托
      </button>
    </template>
  </BaseDialog>
</template>
