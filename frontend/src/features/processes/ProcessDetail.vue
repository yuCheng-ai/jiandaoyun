<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ProcessView, RecordDetail } from "@platform/contracts";
import { platformApi } from "../../repositories/platformApi";
import BaseDialog from "../../components/BaseDialog.vue";
import RecordEditor from "../collaboration/RecordEditor.vue";
const props = defineProps<{ processId: string }>();
const emit = defineEmits<{ close: []; updated: [] }>();
const process = ref<ProcessView>();
const detail = ref<RecordDetail>();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const delegation = ref<ProcessView["tasks"][number]>();
const recipients = ref<{ id: string; name: string }[]>([]);
const recipientId = ref("");
const delegateError = ref("");
const labels = {
  waiting: "等待中",
  ready: "待处理",
  blocked: "需要处理",
  completed: "已完成",
};

async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function load() {
  process.value = await platformApi<ProcessView>(
    `/processes/${props.processId}`,
  );
  emit("updated");
}
async function open(task: ProcessView["tasks"][number]) {
  await run(async () => {
    detail.value = await platformApi<RecordDetail>(
      `/processes/${props.processId}/tasks/${task.id}/record`,
    );
  });
}
async function complete(task: ProcessView["tasks"][number]) {
  await run(async () => {
    process.value = await platformApi<ProcessView>(
      `/processes/${props.processId}/tasks/${task.id}/complete`,
      "POST",
      {},
    );
    notice.value = "任务已完成。";
    emit("updated");
  });
}
async function chooseDelegate(task: ProcessView["tasks"][number]) {
  await run(async () => {
    recipients.value = await platformApi(
      `/processes/${props.processId}/tasks/${task.id}/delegate-options`,
    );
    recipientId.value = "";
    delegateError.value = "";
    delegation.value = task;
  });
}
async function delegate() {
  if (!delegation.value || !recipientId.value || busy.value) return;
  busy.value = true;
  delegateError.value = "";
  try {
    process.value = await platformApi<ProcessView>(
      `/processes/${props.processId}/tasks/${delegation.value.id}/delegate`,
      "POST",
      { assigneeId: recipientId.value },
    );
    delegation.value = undefined;
    notice.value = "待办已委托，可在处理轨迹中查看接手人。";
    emit("updated");
  } catch (cause) {
    delegateError.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function saved() {
  detail.value = undefined;
  await run(async () => {
    await load();
    notice.value = "业务数据已保存，可继续完成任务。";
  });
}
onMounted(() => run(load));
</script>
<template>
  <BaseDialog
    :open="true"
    :title="process?.title || '流程进度'"
    width="960px"
    :busy="busy"
    @close="emit('close')"
  >
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="collab-success" role="status">{{ notice }}</p>
    <template v-if="process">
      <div class="collab-toolbar">
        <div>
          <strong>{{
            process.status === "completed" ? "流程已完成" : "流程进行中"
          }}</strong>
          <p class="collab-help">
            已完成 {{ process.summary?.completed || 0 }} /
            {{ process.summary?.total || process.tasks.length }} 项任务<span
              v-if="process.templateVersion"
            >
              · 发起版本 V{{ process.templateVersion }}</span
            >
          </p>
        </div>
        <button class="button" :disabled="busy" @click="run(load)">
          刷新进度
        </button>
      </div>
      <p v-if="process.refreshError" class="collab-error" role="alert">
        {{ process.refreshError }}
      </p>
      <div class="collab-table-wrap">
        <table class="collab-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>处理人</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in process.tasks" :key="task.id">
              <td>
                {{ task.title
                }}<small v-if="task.rowId" class="process-subtitle"
                  >指定明细行</small
                >
              </td>
              <td>{{ task.assigneeName }}</td>
              <td>
                <span :class="['process-status', task.status]">{{
                  task.kind === "copy" && task.status === "completed"
                    ? "已抄送"
                    : labels[task.status]
                }}</span
                ><small v-if="task.reason" class="process-subtitle">{{
                  task.reason
                }}</small>
              </td>
              <td>
                <div class="process-actions">
                  <button
                    v-if="task.canOpen"
                    class="text-button"
                    :disabled="busy"
                    @click="open(task)"
                  >
                    {{ task.canHandle ? "处理任务" : "查看记录" }}
                  </button>
                  <template v-if="task.canHandle">
                    <button
                      class="text-button"
                      :disabled="busy"
                      @click="complete(task)"
                    >
                      完成任务
                    </button>
                    <button
                      class="text-button"
                      :disabled="busy"
                      @click="chooseDelegate(task)"
                    >
                      委托
                    </button>
                  </template>
                  <span v-if="!task.canOpen" class="collab-help"
                    >由处理人办理</span
                  >
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <details class="process-history" open>
        <summary>处理轨迹</summary>
        <ol v-if="process.events?.length">
          <li v-for="event in process.events" :key="event.id">
            <time>{{ new Date(event.createdAt).toLocaleString("zh-CN") }}</time
            ><span
              >{{ event.taskTitle ? `${event.taskTitle}：` : ""
              }}{{ event.detail
              }}{{ event.actorName ? ` · ${event.actorName}` : "" }}</span
            >
          </li>
        </ol>
        <p v-else class="collab-help">暂无轨迹。</p>
      </details>
    </template>
    <template #footer
      ><button v-if="!process" class="button" @click="run(load)">重试</button
      ><button class="button" @click="emit('close')">关闭</button></template
    >
  </BaseDialog>
  <RecordEditor
    v-if="detail"
    :published="detail"
    :detail="detail"
    @close="detail = undefined"
    @saved="saved"
  />
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
    <p class="collab-help">
      接手人需已有此记录的编辑权限。委托后，你可以查看进度，由接手人办理。
    </p>
    <p v-if="delegateError" class="collab-error" role="alert">
      {{ delegateError }}
    </p>
    <template #footer
      ><button class="button" @click="delegation = undefined">取消</button
      ><button
        class="button primary"
        :disabled="busy || !recipientId"
        @click="delegate"
      >
        确认委托
      </button></template
    >
  </BaseDialog>
</template>
