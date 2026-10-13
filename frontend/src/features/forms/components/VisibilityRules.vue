<script setup lang="ts">
import { computed, ref } from "vue";
import type { ConditionalVisibilityRule, VisibilityCondition } from "@platform/contracts";
import { conditionValueType, conditionDisplayValue } from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import ChoiceFieldControl from "./ChoiceFieldControl.vue";
import { copy, createField, flattenFields, uid, type FormSchema } from "../../../domain/form";
import { editableVisibilityRules, visibilityRuleIssue, visibilityScopes } from "@platform/contracts";
import { resolveChoices } from "../../../domain/relations";
import { useRuntimeData } from "../../../composables/useRuntimeData";

const props = defineProps<{ schema: FormSchema; fieldId?: string; scopeId?: string }>();
const runtime = useRuntimeData();
const allFields = computed(() => flattenFields(props.schema.fields));
const scope = computed(() => visibilityScopes(props.schema.fields).find(scope =>
  props.fieldId ? scope.fields.some(field => field.id === props.fieldId) : scope.id === (props.scopeId ?? ""),
) || visibilityScopes(props.schema.fields)[0]!);
const groups = computed(() => editableVisibilityRules(props.schema.settings.rules));
const displayed = computed(() => groups.value.filter(rule => props.fieldId
  ? rule.conditions.some(condition => condition.sourceId === props.fieldId)
  : scope.value.fields.some(field => rule.targetIds.includes(field.id))));
const open = ref(false), shortcut = ref(false), editing = ref("");
const buffer = ref<ConditionalVisibilityRule[]>([]);
let initial = "";
const error = ref("");
const current = computed(() => buffer.value.find(rule => rule.id === editing.value));
const simple = (rule: ConditionalVisibilityRule) => rule.conditions.length === 1 &&
  rule.conditions[0]!.sourceId === props.fieldId && rule.conditions[0]!.operator === "equals";
const shortcutRules = computed(() => buffer.value.filter(simple));
const otherRules = computed(() => buffer.value.filter(rule => !simple(rule) &&
  rule.conditions.some(condition => condition.sourceId === props.fieldId)));
const targetControl = createField("multiselect", { id: "visibility-targets", placeholder: "请选择显示字段" });
const valueControl = createField("select", { id: "visibility-value", placeholder: "请选择选项" });
const fieldName = (id: string) => allFields.value.find(field => field.id === id)?.label || "已移除字段";
const summary = (rule: ConditionalVisibilityRule) => rule.conditions.map(condition => fieldName(condition.sourceId)).join(rule.match === "any" ? " / " : "、") + ` → ${rule.targetIds.length} 个字段`;
function start(id?: string) {
  buffer.value = copy(groups.value);
  initial = JSON.stringify(buffer.value);
  shortcut.value = !!props.fieldId && !id;
  editing.value = id || "";
  error.value = "";
  open.value = true;
  if (!shortcut.value && !id) addRule();
}
function addRule() {
  if (buffer.value.length >= 200) return;
  const rule: ConditionalVisibilityRule = {
    id: uid("rule"), match: "all", targetIds: [],
    conditions: shortcut.value ? [{ sourceId: props.fieldId!, operator: "equals", value: "" }] : [],
  };
  buffer.value.push(rule);
  if (!shortcut.value) editing.value = rule.id;
}
function remove(id: string) {
  buffer.value = buffer.value.filter(rule => rule.id !== id);
}
function fields(rule: ConditionalVisibilityRule) {
  // Historical cross-scope rules retain their original scope until explicitly replaced.
  return rule.cascade === false ? allFields.value : scope.value.fields;
}
function sources(rule: ConditionalVisibilityRule) {
  return fields(rule).filter(field => !["tabs", "subform", "divider", "button"].includes(field.type));
}
function targets(rule: ConditionalVisibilityRule) {
  return fields(rule).filter(field => !rule.conditions.some(condition => condition.sourceId === field.id))
    .map(field => ({ id: field.id, label: field.label }));
}
function options(condition: VisibilityCondition) {
  const field = allFields.value.find(field => field.id === condition.sourceId);
  if (!field) return [];
  const choices = resolveChoices({ ...field, choiceSource: { ...field.choiceSource, filters: [] } }, runtime.value, {}).map(({ other, ...option }) => option);
  return condition.value && !choices.some(option => option.id === condition.value)
    ? [...choices, { id: condition.value, label: field?.choiceConversion?.options.find(option => option.id === condition.value)?.label || (field?.choiceConversion ? condition.value : "已配置选项") }]
    : choices;
}
function optionField(condition: VisibilityCondition) {
  const field = allFields.value.find(field => field.id === condition.sourceId);
  return { ...valueControl, coloredOptions: field?.coloredOptions, optionColors: field?.optionColors };
}
function changeValue(condition: VisibilityCondition, value: string) {
  condition.value = value;
  const field = allFields.value.find(field => field.id === condition.sourceId);
  condition.valueType = field?.choiceConversion ? conditionValueType(field) : undefined;
}
function displayCondition(condition: VisibilityCondition) {
  return conditionDisplayValue(allFields.value.find(field => field.id === condition.sourceId), condition.value, condition.valueType);
}
function useSource(rule: ConditionalVisibilityRule, condition: VisibilityCondition) {
  changeValue(condition, "");
  rule.targetIds = rule.targetIds.filter(id => id !== condition.sourceId);
}
function setTargets(rule: ConditionalVisibilityRule, value: unknown) {
  rule.targetIds = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}
function apply() {
  if (JSON.stringify(buffer.value) === initial) { open.value = false; return; }
  const before = JSON.parse(initial) as ConditionalVisibilityRule[];
  for (const rule of buffer.value) {
    if (JSON.stringify(rule) === JSON.stringify(before.find(item => item.id === rule.id))) continue;
    error.value = visibilityRuleIssue(rule, props.schema.fields);
    if (!error.value && rule.conditions.some(condition =>
      ["radio", "select", "checkbox", "multiselect"].includes(allFields.value.find(field => field.id === condition.sourceId)?.type || "") &&
      condition.operator !== "empty" && !condition.value)) error.value = "请选择条件值";
    if (error.value) return;
  }
  props.schema.settings.rules = copy(buffer.value);
  open.value = false;
}
</script>

<template>
  <div class="form-group visibility-settings">
    <label>{{ fieldId ? '显隐规则' : scopeId ? '子字段显隐规则' : '字段显隐规则' }}</label>
    <template v-if="!fieldId">
      <div v-for="rule in displayed" :key="rule.id" class="visibility-rule-item">
        <button @click="start(rule.id)">{{ summary(rule) }}</button>
        <button class="icon-button" :aria-label="`删除显隐规则 ${summary(rule)}`"
          @click="schema.settings.rules = copy(groups.filter(item => item.id !== rule.id))">
          <AppIcon name="trash" :size="14" />
        </button>
      </div>
    </template>
    <button class="button full-width" :disabled="scope.fields.length < 2 || (!fieldId && groups.length >= 200)" @click="start()">
      {{ fieldId ? displayed.length ? '已设置显隐规则' : '设置' : '添加显隐规则' }}
    </button>
  </div>
  <BaseDialog :open="open" :title="shortcut ? '显隐规则' : scopeId ? '子字段显隐规则' : '字段显隐规则'" width="700px" class-name="visibility-dialog" @close="open = false">
    <div class="visibility-content">
      <template v-if="shortcut">
        <button class="text-button visibility-add" :disabled="buffer.length >= 200" @click="addRule"><AppIcon name="add" />显隐规则</button>
        <div v-for="(rule, index) in shortcutRules" :key="rule.id" class="visibility-shortcut-row">
          <span>选择</span>
          <ChoiceFieldControl :field="optionField(rule.conditions[0]!)" :choices="options(rule.conditions[0]!)"
            :model-value="rule.conditions[0]!.value" :label="`条件选项 ${index + 1}`"
            @update:model-value="changeValue(rule.conditions[0]!, String($event))" />
          <span>时，显示</span>
          <ChoiceFieldControl :field="targetControl" :choices="targets(rule)" :model-value="rule.targetIds" :disabled="!rule.conditions[0]!.value"
            :label="`显示字段 ${index + 1}`" @update:model-value="setTargets(rule, $event)" />
          <button class="icon-button" :aria-label="`删除显隐规则 ${index + 1}`" @click="remove(rule.id)"><AppIcon name="trash" :size="14" /></button>
        </div>
        <button v-for="rule in otherRules" :key="rule.id" class="text-button visibility-other" @click="editing = rule.id; shortcut = false">{{ summary(rule) }}<AppIcon name="edit" :size="14" /></button>
      </template>
      <template v-else-if="current">
        <div class="visibility-match">满足以下 <div class="select-wrap"><select v-model="current.match" aria-label="条件关系"><option value="all">所有</option><option value="any">任一</option></select><AppIcon name="down" :size="13" /></div> 条件时</div>
        <div v-for="(condition, index) in current.conditions" :key="index" class="visibility-condition-row">
          <div class="select-wrap"><select v-model="condition.sourceId" :aria-label="`条件字段 ${index + 1}`" @change="useSource(current, condition)">
            <option value="">请选择条件字段</option><option v-for="field in sources(current)" :key="field.id" :value="field.id">{{ field.label }}</option>
          </select><AppIcon name="down" :size="13" /></div>
          <div class="select-wrap"><select v-model="condition.operator" :aria-label="`条件比较 ${index + 1}`">
            <option value="equals">等于</option><option value="notEquals">不等于</option><option value="contains">包含</option><option value="greater">大于</option><option value="empty">为空</option>
          </select><AppIcon name="down" :size="13" /></div>
          <ChoiceFieldControl v-if="condition.operator !== 'empty' && ['radio','select','checkbox','multiselect'].includes(allFields.find(field => field.id === condition.sourceId)?.type || '')"
            :field="optionField(condition)" :choices="options(condition)" :model-value="condition.value" :label="`条件值 ${index + 1}`" @update:model-value="changeValue(condition, String($event))" />
          <input v-else-if="condition.operator !== 'empty'" :value="displayCondition(condition)" @input="changeValue(condition, ($event.target as HTMLInputElement).value)" :aria-label="`条件值 ${index + 1}`" placeholder="条件值" />
          <span v-else />
          <button class="icon-button" :aria-label="`删除条件 ${index + 1}`" @click="current.conditions.splice(index, 1)"><AppIcon name="trash" :size="14" /></button>
        </div>
        <button class="text-button visibility-add" @click="current.conditions.push({sourceId: '', operator: 'equals', value: ''})"><AppIcon name="add" />添加条件</button>
        <label class="visibility-target-label">显示以下字段</label>
        <ChoiceFieldControl :field="targetControl" :choices="targets(current)" :model-value="current.targetIds"
          :disabled="!current.conditions.length || current.conditions.some(condition => !condition.sourceId)" label="显示字段" @update:model-value="setTargets(current, $event)" />
      </template>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </div>
    <template #footer><button class="button" @click="open = false">取消</button><button class="button primary" @click="apply">确定</button></template>
  </BaseDialog>
</template>

<style scoped>
.visibility-content { min-height: 310px; }
.visibility-add { margin-bottom: 10px; }
.visibility-match { display: flex; align-items: center; gap: 6px; margin-bottom: 16px; }
.visibility-match .select-wrap { width: 76px; }
.visibility-condition-row { display: grid; grid-template-columns: minmax(0,1fr) 100px minmax(0,1fr) 24px; gap: 8px; align-items: center; margin-bottom: 10px; }
.visibility-shortcut-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto minmax(0,2fr) 24px; gap: 8px; align-items: center; margin-bottom: 10px; }
.visibility-condition-row > *, .visibility-shortcut-row > * { min-width: 0; }
.visibility-target-label { display: block; margin: 16px 0 8px; }
.visibility-other { display: flex; gap: 8px; margin: 12px 0; }
@media (max-width: 600px) {
  .visibility-condition-row { grid-template-columns: minmax(0,1fr) 85px 24px; }
  .visibility-condition-row > :nth-child(3) { grid-row: 2; grid-column: 1 / 3; }
  .visibility-shortcut-row { grid-template-columns: auto minmax(0,1fr) 24px; }
  .visibility-shortcut-row > :nth-child(3) { grid-row: 2; grid-column: 1; }
  .visibility-shortcut-row > :nth-child(4) { grid-row: 2; grid-column: 2; }
}
</style>
