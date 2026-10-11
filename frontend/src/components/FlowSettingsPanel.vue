<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
import type { FlowDocument, FlowSettings } from "../domain/workflow";
const props = defineProps<{ document: FlowDocument }>();
const channels = [
  { id: "app", label: "使用 App 提醒节点负责人、抄送人" },
  { id: "wechat", label: "使用微信提醒节点负责人、抄送人" },
  { id: "email", label: "使用邮件提醒节点负责人、抄送人" },
];
function updateChannel(channel: string, event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  const settings = props.document.settings;
  settings.reminderChannels = enabled
    ? [...new Set([...settings.reminderChannels, channel])]
    : settings.reminderChannels.filter((item) => item !== channel);
  settings.notify = settings.reminderChannels.length > 0;
}
function changeWithdraw(event: Event) {
  const settings = props.document.settings;
  settings.withdrawRule = (event.target as HTMLSelectElement)
    .value as FlowSettings["withdrawRule"];
  settings.allowWithdraw = settings.withdrawRule !== "none";
}
function changeAutoSubmit(event: Event) {
  const settings = props.document.settings;
  settings.autoSubmitRule = (event.target as HTMLSelectElement)
    .value as FlowSettings["autoSubmitRule"];
  settings.deduplicate = settings.autoSubmitRule !== "off";
}
</script>
<template>
  <div class="flow-reminders">
    <div class="setting-heading">
      <strong>流程提醒</strong><span class="audience-label">内部成员</span>
    </div>
    <label v-for="channel in channels" :key="channel.id" class="reminder-option"
      ><input
        type="checkbox"
        :checked="document.settings.reminderChannels.includes(channel.id)"
        @change="updateChannel(channel.id, $event)"
      />{{ channel.label }}</label
    >
  </div>
  <div class="flow-rules">
    <strong class="standalone-label">流程设置</strong>
    <div class="setting-toggle">
      <span
        >允许查看流程动态和流转图
        <AppIcon
          name="help"
          :size="14"
          class="muted-icon"
          title="配置成员是否可查看流程进度" /></span
      ><button
        class="switch"
        :class="{ on: document.settings.viewProgress }"
        role="switch"
        :aria-checked="document.settings.viewProgress"
        aria-label="允许查看流程动态和流转图"
        @click="
          document.settings.viewProgress = !document.settings.viewProgress
        "
      >
        <span />
      </button>
    </div>
    <div class="setting-toggle">
      <span
        >允许流程发起人催办
        <AppIcon
          name="help"
          :size="14"
          class="muted-icon"
          title="配置发起人是否可提醒当前负责人" /></span
      ><button
        class="switch"
        :class="{ on: document.settings.allowUrge }"
        role="switch"
        :aria-checked="document.settings.allowUrge"
        aria-label="允许流程发起人催办"
        @click="document.settings.allowUrge = !document.settings.allowUrge"
      >
        <span />
      </button>
    </div>
    <div class="form-group">
      <label for="withdraw-rule"
        >流程撤回规则 <AppIcon name="help" :size="14" class="muted-icon"
      /></label>
      <div class="select-wrap">
        <select
          id="withdraw-rule"
          :value="document.settings.withdrawRule"
          @change="changeWithdraw"
        >
          <option value="none">不允许撤回</option>
          <option value="start">仅允许发起节点撤回</option>
          <option value="all">允许所有节点撤回</option></select
        ><AppIcon name="down" />
      </div>
    </div>
    <div class="form-group">
      <label for="auto-submit-rule"
        >自动提交规则 <AppIcon name="help" :size="14" class="muted-icon"
      /></label>
      <div class="select-wrap">
        <select
          id="auto-submit-rule"
          :value="document.settings.autoSubmitRule"
          @change="changeAutoSubmit"
        >
          <option value="off">不启用</option>
          <option value="previous">负责人与上一节点处理人相同</option>
          <option value="handled">负责人处理过该流程</option></select
        ><AppIcon name="down" />
      </div>
    </div>
  </div>
</template>
