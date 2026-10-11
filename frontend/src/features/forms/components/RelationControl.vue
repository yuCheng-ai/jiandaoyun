<script setup lang="ts">
import { hasFieldValue } from "@platform/contracts";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import { computed, ref, watch } from "vue";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import { type FormField, type FormValues } from "../../../domain/form";
import type { FormEntry } from "../../../domain/workspace";
import {
  idsOf,
  relationCandidates,
  sourceFields,
  recordLabel,
  displayValue,
  scopeFields,
} from "../../../domain/relations";
const props = withDefaults(
  defineProps<{
    field: FormField;
    fields?: FormField[];
    modelValue?: unknown;
    values?: FormValues;
    entryId?: string;
    disabled?: boolean;
    design?: boolean;
    label: string;
  }>(),
  { values: () => ({}), fields: () => [], entryId: "", disabled: false, design: false },
);
const emit = defineEmits<{ "update:modelValue": [value: string | string[]] }>();
const runtimeData = useRuntimeData();
const open = ref(false),
  query = ref(""),
  selection = ref<string[]>([]),
  page = ref(1),
  detail = ref<FormEntry | null>(null);
const multiple = computed(() => props.field.type === "relationTable"),
  reverse = computed(() => props.field.reference.mode === "reverse");
const available = computed(() =>
  relationCandidates(
    props.field,
    runtimeData.value,
    props.values,
    props.entryId,
    props.fields,
  ),
);
const ids = computed(() =>
  reverse.value ? available.value.map((e) => e.id) : idsOf(props.modelValue),
);
const fields = computed(() =>
  sourceFields(runtimeData.value, props.field.referenceFormId),
);
const columns = computed(() =>
  props.field.reference.columns.length
    ? fields.value.filter((f) => props.field.reference.columns.includes(f.id))
    : fields.value.slice(0, 3),
);
const selectedRecords = computed(() =>
  ids.value
    .map((id) =>
      runtimeData.value.entries.find(
        (e) =>
          e.id === id &&
          e.formId === props.field.referenceFormId &&
          !e.deletedAt,
      ),
    )
    .filter((e): e is FormEntry => !!e),
);
const filtered = computed(() =>
  available.value.filter(
    (e) =>
      !query.value ||
      columns.value
        .map((f) => displayValue(f, e.values[f.id], runtimeData.value))
        .join(" ")
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()) ||
      recordLabel(props.field, e, runtimeData.value).includes(query.value),
  ),
);
const pages = computed(() =>
    Math.max(1, Math.ceil(filtered.value.length / 10)),
  ),
  rows = computed(() =>
    filtered.value.slice((page.value - 1) * 10, page.value * 10),
  );
watch(query, () => (page.value = 1));
watch(pages, (n) => (page.value = Math.min(page.value, n)));
function launch() {
  selection.value = [...ids.value];
  query.value = "";
  page.value = 1;
  open.value = true;
}
function toggle(id: string) {
  selection.value = selection.value.includes(id)
    ? selection.value.filter((i) => i !== id)
    : multiple.value
      ? [...selection.value, id]
      : [id];
}
function confirm() {
  const valid = new Set(available.value.map((e) => e.id));
  const next = selection.value.filter((id) => valid.has(id));
  emit("update:modelValue", multiple.value ? next : next[0] || "");
  open.value = false;
}
function remove(id: string) {
  emit(
    "update:modelValue",
    multiple.value ? ids.value.filter((i) => i !== id) : "",
  );
}
const detailFields = computed(() => {
  const form = runtimeData.value.forms.find(
    (f) => f.id === props.field.referenceFormId,
  );
  const version = form?.versions.find(
    (v) => v.version === detail.value?.definitionVersion,
  );
  return scopeFields(
    version?.schema.fields || form?.schema.fields || [],
  ).filter(hasFieldValue);
});
</script>
<template>
  <div class="relation-control">
    <div v-if="!multiple" class="relation-input">
      <button
        type="button"
        :disabled="disabled"
        :aria-label="label"
        @click="launch"
      >
        <AppIcon name="link" /><span :class="{ muted: !ids.length }">{{
          selectedRecords[0]
            ? recordLabel(field, selectedRecords[0], runtimeData)
            : ids.length
              ? "记录已移除"
              : field.placeholder || "选择关联数据"
        }}</span
        ><AppIcon name="search" /></button
      ><button
        v-if="ids.length && !disabled"
        type="button"
        class="icon-button"
        :aria-label="`清空${label}`"
        @click="remove(ids[0]!)"
      >
        <AppIcon name="close" :size="13" /></button
      ><button
        v-if="selectedRecords[0] && !design"
        type="button"
        class="icon-button"
        :aria-label="`查看${label}详情`"
        @click="detail = selectedRecords[0]"
      >
        <AppIcon name="eye" />
      </button>
    </div>
    <template v-else
      ><div class="relation-table-scroll">
        <table class="relation-table">
          <thead>
            <tr>
              <th>序号</th>
              <th v-for="f in columns" :key="f.id">{{ f.label }}</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, index) in selectedRecords" :key="entry.id">
              <td>{{ index + 1 }}</td>
              <td v-for="f in columns" :key="f.id">
                {{ displayValue(f, entry.values[f.id], runtimeData) }}
              </td>
              <td>
                <button
                  type="button"
                  class="text-button"
                  @click="detail = entry"
                >
                  详情</button
                ><button
                  v-if="!disabled && !reverse"
                  type="button"
                  class="icon-button"
                  :aria-label="`移除关联记录${index + 1}`"
                  @click="remove(entry.id)"
                >
                  <AppIcon name="close" :size="13" />
                </button>
              </td>
            </tr>
            <tr v-if="!selectedRecords.length">
              <td :colspan="columns.length + 2" class="relation-empty">
                {{
                  reverse && !entryId
                    ? "提交后，在数据详情中查看反向关联记录"
                    : "暂无关联记录"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <button
        v-if="!disabled && !reverse"
        type="button"
        class="text-button relation-add"
        :aria-label="label"
        @click="launch"
      >
        <AppIcon name="add" />选择关联记录</button
      ><small v-if="reverse" class="field-hint"
        >根据来源表关联字段自动查询，共 {{ selectedRecords.length }} 条</small
      ></template
    >
    <p v-if="!field.referenceFormId && !design" class="field-hint">
      请在设计器中配置关联表单。
    </p>
  </div>
  <BaseDialog
    :open="open"
    :title="`选择${label}`"
    width="820px"
    @close="open = false"
    ><div class="relation-picker-toolbar">
      <span>{{
        runtimeData.forms.find((f) => f.id === field.referenceFormId)?.title ||
        "未配置表单"
      }}</span>
      <div class="toolbar-spacer" />
      <div class="search-input">
        <AppIcon name="search" /><input
          v-model="query"
          aria-label="搜索关联数据"
          placeholder="搜索关联数据"
        />
      </div>
    </div>
    <div class="relation-picker-scroll">
      <table class="relation-table">
        <thead>
          <tr>
            <th>选择</th>
            <th v-for="f in columns" :key="f.id">{{ f.label }}</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in rows"
            :key="entry.id"
            :class="{ selected: selection.includes(entry.id) }"
          >
            <td>
              <input
                :type="multiple ? 'checkbox' : 'radio'"
                name="relation-pick"
                :checked="selection.includes(entry.id)"
                :aria-label="`选择记录${recordLabel(field, entry, runtimeData)}`"
                @change="toggle(entry.id)"
              />
            </td>
            <td v-for="f in columns" :key="f.id">
              {{ displayValue(f, entry.values[f.id], runtimeData) }}
            </td>
            <td>
              <button
                type="button"
                class="text-button"
                :aria-label="`查看记录${recordLabel(field, entry, runtimeData)}`"
                @click="detail = entry"
              >
                查看
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="relation-empty">
              暂无符合条件的数据
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="relation-pagination">
      <span>共 {{ filtered.length }} 条</span>
      <div class="toolbar-spacer" />
      <button
        type="button"
        class="icon-button"
        :disabled="page === 1"
        aria-label="关联数据上一页"
        @click="page--"
      >
        <AppIcon name="back" /></button
      ><span>{{ page }} / {{ pages }}</span
      ><button
        type="button"
        class="icon-button"
        :disabled="page === pages"
        aria-label="关联数据下一页"
        @click="page++"
      >
        <AppIcon name="right" />
      </button>
    </div>
    <template #footer
      ><span class="dialog-footer-hint">已选择 {{ selection.length }} 条</span
      ><button type="button" class="button" @click="selection = []">
        清空选择</button
      ><button type="button" class="button" @click="open = false">取消</button
      ><button type="button" class="button primary" @click="confirm">
        确定
      </button></template
    ></BaseDialog
  >
  <BaseDialog
    :open="!!detail"
    title="关联记录详情"
    width="660px"
    @close="detail = null"
    ><template v-if="detail"
      ><div class="record-metadata">
        提交于 {{ new Date(detail.createdAt).toLocaleString("zh-CN") }} · V{{
          detail.definitionVersion
        }}
      </div>
      <dl class="relation-record-detail">
        <template v-for="f in detailFields" :key="f.id"
          ><dt>{{ f.label }}</dt>
          <dd v-if="f.type !== 'subform'">
            {{ displayValue(f, detail.values[f.id], runtimeData) }}
          </dd>
          <dd v-else>
            <div class="relation-table-scroll">
              <table class="relation-table">
                <thead>
                  <tr>
                    <th v-for="c in f.children" :key="c.id">{{ c.label }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(row, i) in (detail.values[f.id] as FormValues[]) ||
                    []"
                    :key="i"
                  >
                    <td v-for="c in f.children" :key="c.id">
                      {{ displayValue(c, row[c.id], runtimeData) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </dd></template
        >
      </dl></template
    ><template #footer
      ><button type="button" class="button primary" @click="detail = null">
        关闭
      </button></template
    ></BaseDialog
  >
</template>
