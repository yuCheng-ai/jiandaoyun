<script setup lang="ts">
import { automationEvents } from "../../../domain/events";
import { computed, ref } from "vue";
import AppIcon from "../../../components/AppIcon.vue";
import { copy, uid } from "../../../domain/form";
import {
  automationActions,
  automationIssues,
  type AutomationConfig,
} from "../../../domain/automation";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import type { FormRecord } from "../../../domain/workspace";
const props = defineProps<{ form: FormRecord; query: string }>();
const emit = defineEmits<{ edit: [config?: AutomationConfig]; logs: [] }>();
const runtimeData = useRuntimeData();
const archived = ref(false);
function eventLabel(c: AutomationConfig) {
  return c.events.map((e) => automationEvents[e]).join("、");
}
const configs = computed(() =>
  (props.form.extensions?.automations || []).filter(
    (c) => c.archived === archived.value && c.name.includes(props.query),
  ),
);
function duplicate(c: AutomationConfig) {
  const next = copy(c);
  next.id = uid("automation");
  next.name += " 副本";
  next.enabled = false;
  next.steps.forEach((s) => (s.id = uid("action")));
  emit("edit", next);
}
</script>
<template>
  <div>
    <div class="extension-list-tools">
      <span>{{ configs.length }} 个助手</span
      ><label><input v-model="archived" type="checkbox" />查看已归档</label
      ><button class="button" @click="emit('logs')">查看执行记录</button
      ><button class="button primary" @click="emit('edit')">
        <AppIcon name="add" />新建智能助手
      </button>
    </div>
    <p class="field-hint">
      配置按触发记录所属版本执行。动作仅处理当前浏览器中的表单数据；外部系统请使用数据推送或流程插件。
    </p>
    <div v-if="!configs.length" class="extension-empty">
      <AppIcon name="condition" :size="40" />
      <h2>
        {{
          archived
            ? "没有已归档的助手"
            : query
              ? "没有匹配的助手"
              : "让重复的数据处理自动完成"
        }}
      </h2>
      <p>表单变化后，按条件建立台账、更新状态，或依次完成一组跨表操作。</p>
      <button v-if="!archived && !query" class="button" @click="emit('edit')">
        创建第一个助手
      </button>
    </div>
    <div class="push-config-list">
      <article v-for="c in configs" :key="c.id" class="push-config-card">
        <div class="config-card-title">
          <AppIcon name="condition" :size="24" />
          <div>
            <h3>{{ c.name }}</h3>
            <p>{{ eventLabel(c) }}时触发 · {{ c.steps.length }} 个动作</p>
          </div>
          <span class="status-pill" :class="{ enabled: c.enabled }">{{
            c.archived ? "已归档" : c.enabled ? "已启用" : "已停用"
          }}</span>
        </div>
        <ol class="automation-overview">
          <li v-for="s in c.steps" :key="s.id">
            {{ s.name || automationActions[s.action]
            }}<span
              >{{
                runtimeData.forms.find((f) => f.id === s.targetFormId)?.title ||
                "目标表单不可用"
              }}
              · V{{ s.targetVersion }}</span
            >
          </li>
        </ol>
        <p
          v-if="automationIssues(c, form.schema, runtimeData).length"
          class="config-warning"
        >
          {{ automationIssues(c, form.schema, runtimeData)[0]?.message }}
        </p>
        <div class="config-card-footer">
          <span>{{
            c.filters.length
              ? `${c.filters.length} 个触发条件`
              : "所选事件的全部数据"
          }}</span
          ><button class="text-button" @click="emit('edit', c)">
            编辑与试运行</button
          ><button v-if="!c.archived" class="text-button" disabled>
            {{ c.enabled ? "停用" : "启用" }}</button
          ><button v-if="!c.archived" class="text-button" @click="duplicate(c)">
            复制助手</button
          ><button class="text-button" disabled>
            {{ c.archived ? "恢复助手" : "归档助手" }}
          </button>
        </div>
      </article>
    </div>
  </div>
</template>
