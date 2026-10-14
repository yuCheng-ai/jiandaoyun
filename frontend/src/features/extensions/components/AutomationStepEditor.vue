<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../../components/AppIcon.vue";
import DataFilterEditor from "../../forms/components/DataFilterEditor.vue";
import FieldControl from "../../forms/components/FieldControl.vue";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import {
  automationActions,
  automationDefinition,
  type AutomationStep,
} from "../../../domain/automation";
import { buttonSources, buttonTargets } from "../../../domain/buttons";
import { runtimeDefaults } from "../../../domain/relations";
import type { FormSchema } from "../../../domain/form";
const props = defineProps<{
  step: AutomationStep;
  schema: FormSchema;
  index: number;
  total: number;
}>();
const emit = defineEmits<{ move: [direction: number]; remove: [] }>();
const runtimeData = useRuntimeData();
const forms = computed(() =>
  runtimeData.value.forms.filter((f) => !f.archived && f.published),
);
const form = computed(() =>
  forms.value.find((f) => f.id === props.step.targetFormId),
);
const versions = computed(() =>
  [
    ...new Map(
      [
        ...(form.value?.versions || []),
        ...(form.value?.published ? [form.value.published] : []),
      ].map((v) => [v.version, v]),
    ).values(),
  ].sort((a, b) => b.version - a.version),
);
const definition = computed(() =>
  automationDefinition(form.value, props.step.targetVersion),
);
const sources = computed(() => buttonSources(props.schema));
const targetFields = computed(() =>
  definition.value ? buttonSources(definition.value.schema) : [],
);
const targets = computed(() =>
  definition.value ? buttonTargets(definition.value.schema) : [],
);
const context = computed(() => ({
  ...(definition.value
    ? runtimeDefaults(definition.value.schema.fields, runtimeData.value)
    : {}),
  ...Object.fromEntries(
    props.step.mappings
      .filter((m) => m.source === "constant")
      .map((m) => [m.targetId, m.value]),
  ),
}));
function changeForm() {
  props.step.targetVersion = form.value?.published?.version || 0;
  props.step.filters = [];
  props.step.mappings = [];
  props.step.allowAll = false;
}
</script>
<template>
  <section
    :id="`automation-step-${step.id}`"
    class="automation-action"
    :aria-label="`动作 ${index + 1}`"
    tabindex="-1"
  >
    <header class="automation-action-heading">
      <strong
        >{{ index + 1 }} ·
        {{ step.name || automationActions[step.action] }}</strong
      >
      <div class="automation-action-tools">
        <button
          type="button"
          class="icon-button"
          :aria-label="`上移动作 ${index + 1}`"
          :disabled="!index"
          @click="emit('move', -1)"
        >
          ↑
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="`下移动作 ${index + 1}`"
          :disabled="index === total - 1"
          @click="emit('move', 1)"
        >
          ↓
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="`删除动作 ${index + 1}`"
          @click="emit('remove')"
        >
          <AppIcon name="trash" />
        </button>
      </div>
    </header>
    <div class="button-config-fields">
      <div class="automation-two-columns">
        <label
          >动作名称<input
            v-model="step.name"
            maxlength="40"
            :aria-label="`动作 ${index + 1} 名称`"
            placeholder="例如：更新客户跟进状态"
        /></label>
        <label
          >执行什么<select
            v-model="step.action"
            :aria-label="`动作 ${index + 1} 类型`"
          >
            <option
              v-for="(label, value) in automationActions"
              :key="value"
              :value="value"
            >
              {{ label }}
            </option>
          </select></label
        >
        <label
          >目标表单<select
            v-model="step.targetFormId"
            :aria-label="`动作 ${index + 1} 目标表单`"
            @change="changeForm"
          >
            <option value="">选择已发布表单</option>
            <option v-for="f in forms" :key="f.id" :value="f.id">
              {{ f.title }}
            </option>
          </select></label
        >
        <label
          >使用版本<select
            v-model.number="step.targetVersion"
            :aria-label="`动作 ${index + 1} 目标版本`"
            :disabled="!form"
          >
            <option :value="0">先选择目标表单</option>
            <option v-for="v in versions" :key="v.version" :value="v.version">
              V{{ v.version }} · {{ v.title
              }}{{ v.version === form?.published?.version ? "（当前）" : "" }}
            </option>
          </select></label
        >
      </div>
      <p class="field-hint">
        新增记录使用所选版本；更新保留记录原版本，字段类型不兼容时停止整组动作。
      </p>
      <template v-if="step.action !== 'create'">
        <h4>更新哪些记录？</h4>
        <DataFilterEditor
          v-model="step.filters"
          :source-fields="targetFields"
          :local-fields="sources"
          source-placeholder="选择目标表单字段"
          hint="同时满足以下条件的目标记录。可与本次触发表单的字段值比较。"
        />
        <label v-if="!step.filters.length" class="button-check"
          ><input
            v-model="step.allowAll"
            type="checkbox"
          />允许更新目标表单的全部有效记录</label
        >
        <label v-if="step.action === 'update'"
          >没有匹配记录时<select
            v-model="step.onNoMatch"
            :aria-label="`动作 ${index + 1} 无匹配处理`"
          >
            <option value="skip">跳过此动作，继续下一步</option>
            <option value="fail">停止整组动作</option>
          </select></label
        >
        <p v-else class="field-hint">
          找到记录则更新所有匹配项；没有匹配项则新增一条。
        </p>
      </template>
      <h4>字段写入什么值？</h4>
      <div v-for="(m, i) in step.mappings" :key="i" class="button-mapping-row">
        <select
          v-model="m.targetId"
          :aria-label="`动作 ${index + 1} 映射 ${i + 1} 目标字段`"
          @change="m.value = ''"
        >
          <option value="">选择目标字段</option>
          <option v-for="f in targets" :key="f.id" :value="f.id">
            {{ f.label }}
          </option>
        </select>
        <select
          v-model="m.source"
          :aria-label="`动作 ${index + 1} 映射 ${i + 1} 值来源`"
        >
          <option value="constant">固定值</option>
          <option value="field">触发表单字段</option>
        </select>
        <select
          v-if="m.source === 'field'"
          v-model="m.fieldId"
          :aria-label="`动作 ${index + 1} 映射 ${i + 1} 来源字段`"
        >
          <option value="">选择来源字段</option>
          <option v-for="f in sources" :key="f.id" :value="f.id">
            {{ f.label }}
          </option>
        </select>
        <FieldControl
          v-else-if="targets.find((f) => f.id === m.targetId)"
          v-model="m.value"
          :field="targets.find((f) => f.id === m.targetId)!"
          :values="context"
          :label="`动作 ${index + 1} 映射 ${i + 1} 固定值`"
        />
        <span v-else class="field-hint">先选择目标字段</span>
        <button
          type="button"
          class="icon-button"
          :aria-label="`删除动作 ${index + 1} 映射 ${i + 1}`"
          @click="step.mappings.splice(i, 1)"
        >
          <AppIcon name="trash" />
        </button>
      </div>
      <button
        type="button"
        class="text-button"
        :disabled="!definition || step.mappings.length >= 100"
        :aria-label="`动作 ${index + 1} 添加字段映射`"
        @click="
          step.mappings.push({
            targetId: '',
            source: 'field',
            fieldId: '',
            value: '',
          })
        "
      >
        ＋ 添加字段映射
      </button>
    </div>
  </section>
</template>
