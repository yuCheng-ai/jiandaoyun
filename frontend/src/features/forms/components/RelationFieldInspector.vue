<script setup lang="ts">
import { hasFieldValue } from "@platform/contracts";
import { computed } from "vue";
import AppIcon from "../../../components/AppIcon.vue";
import DataFilterEditor from "./DataFilterEditor.vue";
import {
  findFieldContainer,
  type FormField,
  type FormSchema,
} from "../../../domain/form";
import type { ReferenceConfig } from "../../../domain/fieldConfig";
import {
  sourceFields,
  scopeFields,
  relationTypes,
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
const remoteFields = computed(() =>
  sourceFields(store.data, props.field.referenceFormId),
);
const localFields = computed(() =>
  defaultLinkLocalFields(props.schema.fields, props.field.id),
);
const mappingTargets = computed(() =>
  scopeFields(
    findFieldContainer(props.schema.fields, props.field.id) ||
      props.schema.fields,
  ).filter(
    (f) =>
      f.id !== props.field.id &&
      hasFieldValue(f) &&
      !["calculated", "serial", ...relationTypes].includes(f.type),
  ),
);
const reverseFields = computed(() =>
  remoteFields.value.filter(
    (f) =>
      relationTypes.includes(f.type) &&
      f.referenceFormId === props.formId &&
      f.reference.mode === "forward",
  ),
);
function patch(value: Partial<ReferenceConfig>) {
  emit("update", { reference: { ...props.field.reference, ...value } });
}
function column(id: string, checked: boolean) {
  patch({
    columns: checked
      ? [...props.field.reference.columns, id]
      : props.field.reference.columns.filter((c) => c !== id),
  });
}
function mapping(
  index: number,
  value: { sourceFieldId?: string; targetFieldId?: string },
) {
  patch({
    mappings: props.field.reference.mappings.map((m, i) =>
      i === index ? { ...m, ...value } : m,
    ),
  });
}
const val = (e: Event) => (e.target as HTMLSelectElement).value;
function compatible(source: FormField, target: FormField) {
  if (source.type === "subform" || target.type === "subform")
    return source.type === target.type;
  const multi = ["checkbox", "multiselect", "members", "departments"];
  return multi.includes(source.type) === multi.includes(target.type);
}
</script>
<template>
  <div class="form-group">
    <label for="reference-form">关联表单</label
    ><select
      id="reference-form"
      :value="field.referenceFormId"
      @change="
        emit('update', {
          referenceFormId: val($event),
          referenceFieldId: '',
          reference: {
            ...field.reference,
            columns: [],
            filters: [],
            mappings: [],
            reverseFieldId: '',
          },
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
    ><template v-if="field.type === 'relationTable'"
      ><label class="spaced-label">关联方式</label
      ><select
        :value="field.reference.mode"
        aria-label="关联方式"
        @change="patch({ mode: val($event) as ReferenceConfig['mode'] })"
      >
        <option value="forward">主动选择关联记录</option>
        <option value="reverse">反向展示引用本记录的数据</option>
      </select></template
    ><label for="reference-field" class="spaced-label">显示字段</label
    ><select
      id="reference-field"
      :value="field.referenceFieldId"
      @change="emit('update', { referenceFieldId: val($event) })"
    >
      <option value="">使用第一个字段</option>
      <option v-for="f in remoteFields" :key="f.id" :value="f.id">
        {{ f.label }}
      </option></select
    ><template v-if="field.reference.mode === 'reverse'"
      ><label class="spaced-label">来源表的关联字段</label
      ><select
        :value="field.reference.reverseFieldId"
        aria-label="反向关联字段"
        @change="patch({ reverseFieldId: val($event) })"
      >
        <option value="">选择指向本表的关联字段</option>
        <option v-for="f in reverseFields" :key="f.id" :value="f.id">
          {{ f.label }}
        </option>
      </select>
      <p class="field-hint">
        在已提交记录的详情中自动展示。无需手动维护双向关系。
      </p></template
    >
  </div>
  <div class="form-group">
    <label>展示列</label>
    <div class="config-check-list">
      <label v-for="f in remoteFields" :key="f.id"
        ><input
          type="checkbox"
          :checked="field.reference.columns.includes(f.id)"
          @change="column(f.id, ($event.target as HTMLInputElement).checked)"
        />{{ f.label }}</label
      ><span v-if="!remoteFields.length" class="field-hint"
        >先选择关联表单</span
      >
    </div>
    <p class="field-hint">未指定时展示前三个字段。</p>
  </div>
  <div class="form-group">
    <label>关联数据筛选</label
    ><DataFilterEditor
      :model-value="field.reference.filters"
      :source-fields="remoteFields"
      :local-fields="localFields"
      @update:model-value="patch({ filters: $event })"
    />
  </div>
  <div v-if="field.type !== 'relationTable'" class="form-group">
    <label>选择后回填</label>
    <p class="field-hint">
      将来源表的数据填入当前表单。回填目标需在同一层，修改关联会同步更新。
    </p>
    <div
      v-for="(m, index) in field.reference.mappings"
      :key="index"
      class="data-filter-card"
    >
      <div class="config-card-header">
        <span>映射 {{ index + 1 }}</span
        ><button
          class="icon-button"
          :aria-label="`删除映射${index + 1}`"
          @click="
            patch({
              mappings: field.reference.mappings.filter((_, i) => i !== index),
            })
          "
        >
          <AppIcon name="close" :size="14" />
        </button>
      </div>
      <select
        :value="m.sourceFieldId"
        :aria-label="`映射${index + 1}来源字段`"
        @change="
          mapping(index, { sourceFieldId: val($event), targetFieldId: '' })
        "
      >
        <option value="">来源表字段</option>
        <option
          v-for="f in remoteFields.filter((f) => f.type !== 'subform')"
          :key="f.id"
          :value="f.id"
        >
          {{ f.label }}
        </option>
      </select>
      <div class="mapping-arrow">↓ 填充到</div>
      <select
        :value="m.targetFieldId"
        :aria-label="`映射${index + 1}目标字段`"
        @change="mapping(index, { targetFieldId: val($event) })"
      >
        <option value="">当前表单字段</option>
        <option
          v-for="f in mappingTargets.filter(
            (f) =>
              f.type !== 'subform' &&
              (!remoteFields.find((s) => s.id === m.sourceFieldId) ||
                compatible(
                  remoteFields.find((s) => s.id === m.sourceFieldId)!,
                  f,
                )),
          )"
          :key="f.id"
          :value="f.id"
          :disabled="
            field.reference.mappings.some(
              (other, i) => i !== index && other.targetFieldId === f.id,
            )
          "
        >
          {{ f.label }}
        </option>
      </select>
    </div>
    <button
      class="text-button"
      @click="
        patch({
          mappings: [
            ...field.reference.mappings,
            { sourceFieldId: '', targetFieldId: '' },
          ],
        })
      "
    >
      <AppIcon name="add" />添加字段映射
    </button>
  </div>
</template>
