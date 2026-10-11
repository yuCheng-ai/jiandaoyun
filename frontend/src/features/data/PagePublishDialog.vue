<script setup lang="ts">
import type { PagePublishImpact } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
defineProps<{ impact?: PagePublishImpact; busy: boolean; error: string }>();
defineEmits<{ close: []; retry: []; confirm: [] }>();
const kinds = { page: "页面", relation: "数据关系", process: "流程" };
</script>
<template>
  <BaseDialog :open="true" title="发布表单" width="760px" :busy="busy" @close="$emit('close')">
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <template v-if="impact">
      <p>「{{ impact.title }}」将发布为 V{{ impact.toVersion }}。</p>
      <section class="publication-section" aria-label="本次字段变化">
        <strong>字段修改</strong>
        <ul v-if="impact.newFields.length"><li v-for="field in impact.newFields" :key="field.id">新增 {{ field.parentName ? `${field.parentName} / ` : '' }}{{ field.name }}</li></ul>
        <p v-if="impact.fieldChanges?.changed.length">调整设置：{{ impact.fieldChanges.changed.join('、') }}</p>
        <p v-if="impact.fieldChanges?.renamed.length">修改名称：{{ impact.fieldChanges.renamed.join('、') }}</p>
        <p v-if="impact.fieldChanges?.removed.length">删除字段：{{ impact.fieldChanges.removed.join('、') }}。已有记录保留原字段和数据。</p>
        <p v-if="!impact.newFields.length && !impact.fieldChanges?.changed.length && !impact.fieldChanges?.renamed.length && !impact.fieldChanges?.removed.length">字段设置保持原样。</p>
        <p v-if="impact.newFields.length" class="collab-help">新增字段与本页控件一起生效，成员可见范围仍按当前表单和角色权限执行。</p>
      </section>
      <section class="publication-section" aria-label="本次页面变化">
        <strong>当前页面</strong>
        <p v-if="impact.controls.added.length">增加控件：{{ impact.controls.added.join('、') }}</p>
        <p v-if="impact.controls.removed.length && !impact.fieldChanges">移除控件：{{ impact.controls.removed.join('、') }}。数据字段和已有值保留。</p>
        <p v-if="impact.controls.changed.length">调整控件：{{ impact.controls.changed.join('、') }}</p>
        <p v-if="impact.controls.layoutChanged">排列顺序或页面设置有调整。</p><p v-if="impact.controls.titleChanged">页面名称有调整。</p>
        <p v-if="!impact.controls.added.length && !impact.controls.removed.length && !impact.controls.changed.length && !impact.controls.layoutChanged && !impact.controls.titleChanged">控件、布局和名称保持原样。</p>
      </section>
      <section class="publication-section" aria-label="数据与任务处理">
        <strong>已有数据与任务</strong>
        <p v-if="impact.records.length">{{ impact.records.map(item => `数据 V${item.version}：${item.count} 条记录`).join('；') }}。已有记录保留原版本和数据，新增字段需通过兼容升级采用。</p><p v-else>暂无已有记录。</p>
        <p v-for="item in impact.tasks" :key="item.version">本页 V{{ item.version }}：{{ item.active }} 个未完成任务，{{ item.completed }} 个已完成任务。任务继续使用原处理页面。</p>
        <p v-if="!impact.tasks.length">暂无任务绑定本页。</p>
      </section>
      <details v-if="impact.references.length" class="publication-section"><summary>相关配置（{{ impact.references.length }} 项）</summary>
        <p class="collab-help">以下配置保持各自版本。其他页面采用新字段、流程改用新页面，都需要明确编辑并发布。</p>
        <ul class="publication-references"><li v-for="(item, index) in impact.references" :key="`${item.kind}-${item.id}-${item.state}-${index}`"><strong>{{ kinds[item.kind] }} · {{ item.title }}</strong><span class="collab-help">{{ item.state === 'published' ? `已发布 V${item.version}` : '草稿' }}</span><p>{{ item.detail }}</p></li></ul>
        <p v-if="!impact.references.length">暂无其他页面、关系或流程使用此数据。</p>
      </details>
    </template>
    <p v-else-if="!busy && !error">正在准备发布检查…</p>
    <template #footer><button class="button" @click="$emit('close')">继续编辑</button><button v-if="error || !impact" class="button" :disabled="busy" @click="$emit('retry')">重新检查</button><button class="button primary" :disabled="busy || !impact || !!error" @click="$emit('confirm')">确认发布</button></template>
  </BaseDialog>
</template>
<style scoped>
.publication-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid #e7ebef; }
.publication-section p { margin: 8px 0; line-height: 1.6; overflow-wrap: anywhere; }
.publication-section ul { padding-left: 20px; line-height: 1.8; }
.publication-section summary { cursor: pointer; font-weight: 600; }
.publication-references { list-style: none; padding-left: 0 !important; }
.publication-references li { padding: 8px 0; }
.publication-references span { margin-left: 8px; }
</style>
