<script setup lang="ts">
import type { DataModelImpact, ModelFieldChange } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
defineProps<{ impact?: DataModelImpact; busy: boolean; error: string }>();
defineEmits<{ close: []; retry: []; confirm: [] }>();
const kinds = { page: "页面", relation: "数据关系", process: "流程", permission: "权限" };
const changeKinds = { added: "新增", removed: "移出新版本", changed: "调整规则", renamed: "更名" };
const fieldName = (field: ModelFieldChange) => `${field.parentName ? `${field.parentName} / ` : ''}${field.beforeName ? `${field.beforeName} → ` : ''}${field.name}`;
</script>
<template>
  <BaseDialog :open="true" title="检查数据字段变更" width="800px" :busy="busy" @close="$emit('close')">
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <template v-if="impact">
      <p>「{{ impact.title }}」将发布数据 V{{ impact.toVersion }}。{{ impact.defaultPageWillPublish ? '默认页面同时发布；其他页面、已有记录和已发任务保留各自版本。' : '现有页面、记录和已发任务保留各自版本。' }}</p>
      <div v-if="impact.blockers.length" class="collab-error" role="alert"><strong>以下使用情况需要先处理</strong><ul><li v-for="blocker in impact.blockers" :key="blocker">{{ blocker }}</li></ul></div>
      <section class="model-impact-section" aria-label="字段变更明细">
        <strong>本次修改</strong>
        <template v-for="(label, kind) in changeKinds" :key="kind"><ul v-if="impact.changes[kind].length"><li v-for="field in impact.changes[kind]" :key="field.id">{{ label }}：{{ fieldName(field) }}<p v-for="detail in field.details" :key="detail" class="collab-help">{{ detail }}</p></li></ul></template>
        <p v-if="impact.titleChanged">数据对象名称有调整。</p>
        <p v-if="!impact.titleChanged && !Object.values(impact.changes).some(items => items.length)">字段和约束保持原样；字段顺序以当前草稿为准。</p>
        <p v-if="impact.changes.removed.length" class="collab-help">移出新版本不会清除历史记录中的值。已发布版本仍保留原字段。</p>
        <p v-if="impact.changes.added.length" class="collab-help">其他页面自行选择采用新增字段；普通成员需要另行获得字段权限。</p>
      </section>
      <section class="model-impact-section" aria-label="历史记录与任务">
        <strong>已有数据</strong>
        <p v-for="item in impact.records" :key="item.version">数据 V{{ item.version }}：{{ item.count }} 条使用中，{{ item.archived }} 条已归档。<span v-if="item.incompatible" class="danger">其中 {{ item.incompatible }} 条使用中记录的现值或新增字段默认值不符合本次新规则。</span></p>
        <p v-if="impact.organizationCheck" class="collab-help">{{ impact.organizationCheck }}</p>
        <p v-if="!impact.records.length">暂无记录。</p>
        <p class="collab-help">这里只检查新增和调整的字段规则，不执行数据迁移。现有记录按原规则继续使用；记录升级仍需单独检查，目前仅支持兼容新增。</p>
        <p v-for="item in impact.tasks" :key="item.version">数据 V{{ item.version }}：{{ item.active }} 个未完成任务，{{ item.completed }} 个已完成任务，处理依据保持原版本。</p>
      </section>
      <details class="model-impact-section" :open="impact.references.length < 7"><summary>使用情况（{{ impact.references.length }} 项）</summary>
        <ul class="model-impact-references"><li v-for="(item, index) in impact.references" :key="index"><strong>{{ kinds[item.kind] }} · {{ item.title }}</strong><span class="collab-help">{{ item.state === 'draft' ? '草稿' : item.version ? `已发布 V${item.version}` : '当前授权' }}</span><p v-if="item.fields.length">涉及修改字段：{{ item.fields.join('、') }}</p><p :class="item.effect === 'blocks' ? 'danger' : 'collab-help'">{{ item.detail }}</p></li></ul>
        <p v-if="!impact.references.length">暂无其他配置使用此数据对象。</p>
      </details>
    </template>
    <p v-else-if="busy" role="status">正在检查字段和使用情况…</p>
    <template #footer><button class="button" @click="$emit('close')">继续编辑</button><button v-if="error || !impact" class="button" :disabled="busy" @click="$emit('retry')">重新检查</button><button class="button primary" :disabled="busy || !impact || !!error || !!impact.blockers.length" @click="$emit('confirm')">确认发布数据</button></template>
  </BaseDialog>
</template>
<style scoped>
.model-impact-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid #e7ebef; }
.model-impact-section p { margin: 8px 0; line-height: 1.6; overflow-wrap: anywhere; }
.model-impact-section ul { padding-left: 20px; line-height: 1.8; }
.model-impact-section summary { cursor: pointer; font-weight: 600; }
.model-impact-references { list-style: none; padding-left: 0 !important; }
.model-impact-references li { padding: 8px 0; }
.model-impact-references span { margin-left: 8px; }
</style>
