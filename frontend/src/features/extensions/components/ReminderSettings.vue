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
import AppIcon from "../../../components/AppIcon.vue";
import ReminderEditor from "./ReminderEditor.vue";
const props = defineProps<{ form: FormRecord; query: string }>();
const archived = ref(false),
  open = ref(false),
  editing = ref<ReminderConfig>();
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
</script>
<template>
  <div>
    <div class="extension-list-tools">
      <span>{{ configs.length }} 条提醒</span
      ><label><input v-model="archived" type="checkbox" />查看已归档提醒</label
      ><button class="button" disabled>
        <AppIcon name="time" />检查到期提醒</button
      ><button class="button primary" @click="edit()">
        <AppIcon name="add" />新建推送提醒
      </button>
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
          ><button v-if="!c.archived" class="text-button" disabled>
            {{ c.enabled ? "停用" : "启用" }}</button
          ><button v-if="!c.archived" class="text-button" @click="duplicate(c)">
            复制提醒</button
          ><button class="text-button" disabled>
            {{ c.archived ? "恢复提醒" : "归档提醒" }}
          </button>
        </div>
      </article>
    </div>
    <ReminderEditor
      v-if="open"
      :open="open"
      :model-value="editing"
      :schema="form.schema"
      :form-id="form.id"
      @close="open = false"
    />
  </div>
</template>
