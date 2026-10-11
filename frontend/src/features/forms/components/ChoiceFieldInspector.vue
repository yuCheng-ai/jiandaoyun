<script setup lang="ts">
import { computed } from "vue";
import ChoiceSettings from "./ChoiceSettings.vue";
import VisibilityRules from "./VisibilityRules.vue";
import ManualChoiceEditor from "./ManualChoiceEditor.vue";
import DataFilterEditor from "./DataFilterEditor.vue";
import { type FormField, type FormSchema } from "../../../domain/form";
import type { ChoiceSource } from "../../../domain/fieldConfig";
import {
  sourceFields,
  resolveChoices,
  defaultLinkLocalFields,
} from "../../../domain/relations";
import { useWorkspaceStore } from "../../../stores/workspace";
const props = defineProps<{
  field: FormField;
  schema: FormSchema;
  formId: string;
}>();
const emit = defineEmits<{ update: [value: Partial<FormField>] }>();
const store = useWorkspaceStore();
const multiple = computed(() =>
  ["checkbox", "multiselect"].includes(props.field.type),
);
const source = computed(() => props.field.choiceSource);
const remoteFields = computed(() =>
  sourceFields(store.data, source.value.formId).filter(
    (f) => !["subform", "divider", "button"].includes(f.type),
  ),
);
const localFields = computed(() =>
  defaultLinkLocalFields(props.schema.fields, props.field.id),
);
const options = computed(() => resolveChoices(props.field, store.data, {}));
function patch(value: Partial<ChoiceSource>) {
  emit("update", { choiceSource: { ...source.value, ...value } });
}
function defaults(id: string) {
  const old = Array.isArray(props.field.defaultValue)
    ? props.field.defaultValue
    : [];
  emit("update", {
    defaultValue: multiple.value
      ? old.includes(id)
        ? old.filter((v) => v !== id)
        : [...old, id]
      : props.field.defaultValue === id
        ? ""
        : id,
  });
}
</script>
<template>
  <div class="form-group">
    <label>选项来源</label
    ><select
      :value="source.mode"
      aria-label="选项来源"
      @change="
        patch({
          mode: ($event.target as HTMLSelectElement)
            .value as ChoiceSource['mode'],
        });
        emit('update', { defaultValue: multiple ? [] : '' });
      "
    >
      <option value="manual">自定义选项</option>
      <option value="form">其他表单数据</option>
    </select>
  </div>
  <template v-if="source.mode === 'manual'">
    <div class="form-group">
      <ManualChoiceEditor
        appearance
        :field="field"
        @update="emit('update', $event)"
      /></div></template
  ><template v-else
    ><div class="form-group">
      <label>数据表单</label
      ><select
        :value="source.formId"
        aria-label="选项数据表单"
        @change="
          patch({
            formId: ($event.target as HTMLSelectElement).value,
            labelFieldId: '',
            valueFieldId: '',
            filters: [],
          })
        "
      >
        <option value="">请选择表单</option>
        <option
          v-for="f in store.activeForms.filter((f) => f.id !== formId)"
          :key="f.id"
          :value="f.id"
        >
          {{ f.title }}
        </option></select
      ><label class="spaced-label">显示字段</label
      ><select
        :value="source.labelFieldId"
        aria-label="选项显示字段"
        @change="
          patch({ labelFieldId: ($event.target as HTMLSelectElement).value })
        "
      >
        <option value="">请选择字段</option>
        <option v-for="f in remoteFields" :key="f.id" :value="f.id">
          {{ f.label }}
        </option></select
      ><label class="spaced-label">保存值</label
      ><select
        :value="source.valueFieldId"
        aria-label="选项保存值字段"
        @change="
          patch({ valueFieldId: ($event.target as HTMLSelectElement).value })
        "
      >
        <option value="">记录 ID</option>
        <option v-for="f in remoteFields" :key="f.id" :value="f.id">
          {{ f.label }}
        </option></select
      ><label class="spaced-label">排序</label
      ><select
        :value="source.sort"
        aria-label="选项排序"
        @change="
          patch({
            sort: ($event.target as HTMLSelectElement)
              .value as ChoiceSource['sort'],
          })
        "
      >
        <option value="none">按数据顺序</option>
        <option value="asc">名称升序</option>
        <option value="desc">名称降序</option></select
      ><label class="checkbox-line"
        ><input
          type="checkbox"
          :checked="source.deduplicate"
          @change="
            patch({ deduplicate: ($event.target as HTMLInputElement).checked })
          "
        />相同名称只显示一次</label
      >
    </div>
    <div class="form-group">
      <label>筛选与级联</label
      ><DataFilterEditor
        :model-value="source.filters"
        :source-fields="remoteFields"
        :local-fields="localFields"
        @update:model-value="patch({ filters: $event })"
      />
    </div>
    <div
      v-if="!source.filters.some((f) => f.source === 'field')"
      class="form-group"
    >
      <label>默认选项</label>
      <div class="config-check-list">
        <label v-for="o in options" :key="o.id"
          ><input
            type="checkbox"
            :checked="
              multiple
                ? Array.isArray(field.defaultValue) &&
                  field.defaultValue.includes(o.id)
                : field.defaultValue === o.id
            "
            @change="defaults(o.id)"
          />{{ o.label }}</label
        ><span v-if="!options.length" class="field-hint"
          >来源表暂无可用数据</span
        >
      </div>
    </div></template
  >
  <VisibilityRules
    v-if="['radio', 'select'].includes(field.type)"
    :key="field.id"
    :schema="schema"
    :field-id="field.id"
  />
  <ChoiceSettings
    :field="field"
    section="layout"
    @update="emit('update', $event)"
  />
</template>
