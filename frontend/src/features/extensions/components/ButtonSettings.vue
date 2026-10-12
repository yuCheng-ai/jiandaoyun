<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "../../../components/AppIcon.vue";
import ButtonEditor from "./ButtonEditor.vue";
import { useWorkspaceStore } from "../../../stores/workspace";
import type { FormRecord } from "../../../domain/workspace";
import {
  buttonActions,
  buttonPositions,
  buttonIssues,
  type CustomButton,
} from "../../../domain/buttons";
import { copy, uid } from "../../../domain/form";
const props = defineProps<{ form: FormRecord; query: string }>();
const store = useWorkspaceStore(),
  archived = ref(false),
  open = ref(false),
  editing = ref<CustomButton>();
const configs = computed(() =>
  (props.form.extensions?.buttons || []).filter(
    (c) => c.archived === archived.value && c.name.includes(props.query),
  ),
);
function edit(c?: CustomButton) {
  editing.value = c;
  open.value = true;
}
function duplicate(c: CustomButton) {
  edit({
    ...copy(c),
    id: uid("button"),
    name: c.name + " 副本",
    enabled: false,
  });
}
async function toggle(c: CustomButton) {
  const next = { ...copy(c), enabled: !c.enabled };
  if (
    next.enabled &&
    buttonIssues(next, props.form.schema, store.data).length
  ) {
    edit(next);
    return;
  }
  if (await store.saveButton(props.form.id, next))
    store.notify("按钮状态已保存，发布新版本后生效");
}
async function archive(c: CustomButton) {
  if (
    await store.saveButton(props.form.id, {
      ...copy(c),
      archived: !c.archived,
      enabled: false,
    })
  )
    store.notify("归档状态已保存，历史记录保留原版本按钮");
}
function positionsLabel(c: CustomButton) {
  return c.positions.map((p) => buttonPositions[p]).join("、");
}
</script>
<template>
  <div>
    <div class="extension-list-tools">
      <span>{{ configs.length }} 个按钮</span
      ><label><input v-model="archived" type="checkbox" />查看已归档</label
      ><button class="button primary" @click="edit()">
        <AppIcon name="add" />新建自定义按钮
      </button>
    </div>
    <p class="field-hint">
      填写页使用当前发布版本；详情与列表按钮使用记录所属版本。配置变更发布后用于新记录。
    </p>
    <div v-if="!configs.length" class="extension-empty">
      <AppIcon name="button" :size="40" />
      <h2>
        {{
          archived
            ? "没有已归档的按钮"
            : query
              ? "没有匹配的按钮"
              : "把常用操作放到数据旁边"
        }}
      </h2>
      <p>让用户更新字段、带值打开另一张表单，或前往相关链接。</p>
      <button v-if="!archived && !query" class="button" @click="edit()">
        创建第一个按钮
      </button>
    </div>
    <div class="push-config-list">
      <article v-for="c in configs" :key="c.id" class="push-config-card">
        <div class="config-card-title">
          <AppIcon name="button" :size="24" />
          <div>
            <h3>{{ c.name }}</h3>
            <p>
              {{ buttonActions[c.action] }} ·
              {{ positionsLabel(c) }}
            </p>
          </div>
          <span class="status-pill" :class="{ enabled: c.enabled }">{{
            c.archived ? "已归档" : c.enabled ? "已启用" : "已停用"
          }}</span>
        </div>
        <p
          v-if="buttonIssues(c, form.schema, store.data).length"
          class="config-warning"
        >
          {{ buttonIssues(c, form.schema, store.data)[0]?.message }}
        </p>
        <div class="config-card-footer">
          <span>{{
            c.filters.length ? `${c.filters.length} 个显示条件` : "始终显示"
          }}</span
          ><button class="text-button" @click="edit(c)">编辑与检查</button
          ><button v-if="!c.archived" class="text-button" @click="toggle(c)">
            {{ c.enabled ? "停用" : "启用" }}</button
          ><button v-if="!c.archived" class="text-button" @click="duplicate(c)">
            复制按钮</button
          ><button class="text-button" @click="archive(c)">
            {{ c.archived ? "恢复按钮" : "归档按钮" }}
          </button>
        </div>
      </article>
    </div>
    <ButtonEditor
      :open="open"
      :model-value="editing"
      :schema="form.schema"
      :form-id="form.id"
      @close="open = false"
    />
  </div>
</template>
