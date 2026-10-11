<script setup lang="ts">
import { computed, ref } from "vue";
import { copy, uid } from "../../../domain/form";
import type { FormRecord } from "../../../domain/workspace";
import { pushEvents } from "../../../domain/extensions";
import {
  reminderChannels,
  reminderIssues,
  reminderTemplateLabel,
  type ReminderConfig,
} from "../../../domain/reminders";
import { useWorkspaceStore } from "../../../stores/workspace";
import AppIcon from "../../../components/AppIcon.vue";
import ReminderEditor from "./ReminderEditor.vue";
const props = defineProps<{ form: FormRecord; query: string }>();
const emit = defineEmits<{ logs: [] }>();
const store = useWorkspaceStore(),
  archived = ref(false),
  open = ref(false),
  editing = ref<ReminderConfig>(),
  summary = ref("");
const configs = computed(() =>
  (props.form.extensions?.reminders || []).filter(
    (c) => c.archived === archived.value && c.name.includes(props.query),
  ),
);
function triggerLabel(c: ReminderConfig) {
  return c.trigger === "event"
    ? c.events.map((e) => pushEvents[e]).join("、")
    : `日期提醒 · ${c.offsetDays < 0 ? "提前" + -c.offsetDays + "天" : c.offsetDays > 0 ? "延后" + c.offsetDays + "天" : "当天"} ${c.time}`;
}
function edit(c?: ReminderConfig) {
  editing.value = c;
  open.value = true;
}
function duplicate(c: ReminderConfig) {
  edit({
    ...copy(c),
    id: uid("reminder"),
    name: c.name + " 副本",
    enabled: false,
  });
}
async function toggle(c: ReminderConfig) {
  const next = { ...copy(c), enabled: !c.enabled };
  if (next.enabled && reminderIssues(next, props.form.schema).length) {
    edit(next);
    store.notify("请先修复配置，再启用提醒", "warning");
    return;
  }
  if (await store.saveReminder(props.form.id, next))
    store.notify("提醒状态已保存，发布后生效");
}
async function archive(c: ReminderConfig) {
  if (
    await store.saveReminder(props.form.id, {
      ...copy(c),
      archived: !c.archived,
      enabled: false,
    })
  )
    store.notify("归档状态已保存，发布后用于新记录；历史记录保留原版本规则");
}
async function check() {
  const result = await store.checkDueReminders(props.form.id);
  if (result)
    summary.value = `检查完成：模拟成功 ${result.success} 条，失败 ${result.failed} 条，条件不符 ${result.skipped} 条，已提醒 ${result.already} 条，未到期 ${result.future} 条，日期缺失或无效 ${result.invalidDate} 条。`;
  else summary.value = "本次检查未保存，请处理提示后重试。";
}
</script>
<template>
  <div>
    <div class="extension-list-tools">
      <span>{{ configs.length }} 条提醒</span
      ><label><input v-model="archived" type="checkbox" />查看已归档提醒</label
      ><button class="button" @click="check">
        <AppIcon name="time" />检查到期提醒</button
      ><button class="button primary" @click="edit()">
        <AppIcon name="add" />新建推送提醒
      </button>
    </div>
    <div v-if="summary" class="reminder-check-summary" role="status">
      <span>{{ summary }}</span
      ><button class="text-button" @click="emit('logs')">查看执行记录</button>
    </div>
    <p class="field-hint">
      日期提醒需手动检查，覆盖已提交且未回收的记录，按各自发布版本执行；同一日期已成功提醒的记录不会重复。所有消息通道均为本地模拟。
    </p>
    <div v-if="!configs.length" class="extension-empty">
      <AppIcon name="bell" :size="40" />
      <h2>
        {{
          archived
            ? "没有已归档的提醒"
            : query
              ? "没有匹配的提醒"
              : "把关键变化及时告诉相关的人"
        }}
      </h2>
      <p>数据变化时通知负责人，或在指定日期前提醒相关成员。</p>
      <button v-if="!archived && !query" class="button" @click="edit()">
        创建第一条提醒
      </button>
    </div>
    <div class="push-config-list">
      <article v-for="c in configs" :key="c.id" class="push-config-card">
        <div class="config-card-title">
          <AppIcon name="bell" :size="24" />
          <div>
            <h3>{{ c.name }}</h3>
            <p>
              {{ triggerLabel(c) }}
              · {{ reminderChannels[c.channel] }}
            </p>
          </div>
          <span class="status-pill" :class="{ enabled: c.enabled }">{{
            c.archived ? "已归档" : c.enabled ? "启用 · 本地模拟" : "已停用"
          }}</span>
        </div>
        <p v-if="reminderIssues(c, form.schema).length" class="config-warning">
          {{ reminderIssues(c, form.schema)[0]?.message }}
        </p>
        <p class="reminder-list-message">
          {{ reminderTemplateLabel(c.title, form.schema) }}
        </p>
        <div class="config-card-footer">
          <span>{{
            c.recipients.source === "field"
              ? "接收人来自记录字段"
              : "指定成员、部门或角色"
          }}</span
          ><button class="text-button" @click="edit(c)">编辑与试运行</button
          ><button v-if="!c.archived" class="text-button" @click="toggle(c)">
            {{ c.enabled ? "停用" : "启用" }}</button
          ><button v-if="!c.archived" class="text-button" @click="duplicate(c)">
            复制提醒</button
          ><button class="text-button" @click="archive(c)">
            {{ c.archived ? "恢复提醒" : "归档提醒" }}
          </button>
        </div>
      </article>
    </div>
    <ReminderEditor
      :open="open"
      :model-value="editing"
      :schema="form.schema"
      :form-id="form.id"
      @close="open = false"
    />
  </div>
</template>
