<script setup lang="ts">
import { computed, ref, watch, useId, onMounted, onBeforeUnmount } from "vue";
import type { FrontendDataSelection } from "@platform/contracts";
import {
  copy,
  uid,
  type FormField,
  type FormValues,
} from "../../../domain/form";
import type { SelectionFilter } from "../../../domain/fieldConfig";
import type { WorkspaceData } from "../../../domain/workspace";
import {
  selectionCandidates,
  selectionSourceFields,
  selectionDisplayValue,
  selectionSourceValue,
  selectionFilterFields,
  selectionFilterError,
  filterSelectionCandidates,
  type SelectionProfile,
} from "../../../domain/frontendSelections";
import AppIcon from "../../../components/AppIcon.vue";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import { displayValue } from "../../../domain/relations";
import DataFilterEditor from "./DataFilterEditor.vue";
const props = withDefaults(
  defineProps<{
    config: FrontendDataSelection;
    data: WorkspaceData;
    values: FormValues;
    inputs: FormField[];
    selectedId?: string;
    selectedIds?: string[];
    multiple?: boolean;
    profile?: SelectionProfile;
    selectable?: boolean;
  }>(),
  { selectable: true, profile: "event", selectedIds: () => [] },
);
const emit = defineEmits<{
  select: [id: string];
  changeSelection: [ids: string[]];
}>();
const query = ref(""),
  page = ref(1);
const radioGroup = useId();
const fields = computed(() =>
  selectionSourceFields(props.data, props.config.formId, props.profile),
);
const columns = computed(() =>
  props.config.columns.flatMap(
    (id) => fields.value.find((field) => field.id === id) || [],
  ),
);
const baseline = computed(() =>
  selectionCandidates(
    props.config,
    props.data,
    props.values,
    props.inputs,
    "",
    props.profile,
  ),
);
const filterOpen = ref(false),
  filters = ref<SelectionFilter[]>([]),
  filterDraft = ref<SelectionFilter[]>([]),
  filterError = ref("");
const filterTrigger = ref<HTMLButtonElement>(),
  filterPanel = ref<HTMLElement>();
const filterPosition = ref({ left: "0px", top: "0px" });
const closeFilter = () => {
  filterOpen.value = false;
};
const { zIndex } = useDialogLayer(filterPanel, closeFilter, () => {}, {
  modal: false,
  anchor: () => filterTrigger.value,
  initialFocus: () =>
    filterPanel.value?.querySelector<HTMLSelectElement>("select") || undefined,
});
const filterFields = computed(() =>
  selectionFilterFields(props.config, fields.value).map((field) => ({
    ...field,
    label: props.config.columnLabels?.[field.id] || field.pathLabel,
  })),
);
const filterOptions = computed(() =>
  Object.fromEntries(
    filterFields.value.map((field) => {
      const choices = new Map<string, string>();
      for (const entry of baseline.value) {
        try {
          const raw = selectionSourceValue(entry, field, props.data);
          for (const value of Array.isArray(raw) ? raw.flat() : [raw]) {
            if (
              value !== "" &&
              value != null &&
              ["string", "number"].includes(typeof value)
            )
              choices.set(
                String(value),
                displayValue(field, value, props.data),
              );
          }
        } catch {
          /* Inaccessible values never become filter suggestions. */
        }
      }
      return [
        field.id,
        [...choices]
          .map(([id, label]) => ({ id, label }))
          .sort((a, b) =>
            a.label.localeCompare(b.label, "zh-CN", { numeric: true }),
          ),
      ];
    }),
  ),
);
function showFilter() {
  if (filterOpen.value) return closeFilter();
  const rect = filterTrigger.value!.getBoundingClientRect();
  filterPosition.value = {
    left: `${Math.max(8, Math.min(rect.right - 640, window.innerWidth - 648))}px`,
    top: `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 260))}px`,
  };
  filterDraft.value = filters.value.length
    ? copy(filters.value)
    : [
        {
          id: uid("filter"),
          sourceFieldId: "",
          operator: "equals",
          source: "constant",
          value: "",
        },
      ];
  filterError.value = "";
  filterOpen.value = true;
}
function applyFilters() {
  filterError.value = selectionFilterError(
    filterDraft.value,
    filterFields.value,
  );
  if (filterError.value) return;
  filters.value = copy(filterDraft.value);
  filterOpen.value = false;
}
function clearFilters() {
  filters.value = [];
  filterDraft.value = [];
  filterError.value = "";
}
const candidates = computed(() =>
  filterSelectionCandidates(
    query.value.trim()
      ? selectionCandidates(
          props.config,
          props.data,
          props.values,
          props.inputs,
          query.value,
          props.profile,
        )
      : baseline.value,
    props.config,
    props.data,
    filters.value,
    props.profile,
  ),
);
watch(
  () =>
    JSON.stringify([
      props.config,
      props.data.organization.currentUserId,
      props.data.forms.find((form) => form.id === props.config.formId)
        ?.published?.version,
      filterFields.value.map((field) => [
        field.id,
        field.parentId,
        field.type,
        field.format,
      ]),
    ]),
  () => {
    clearFilters();
    query.value = "";
    closeFilter();
  },
);
onMounted(() => window.addEventListener("resize", closeFilter));
onBeforeUnmount(() => window.removeEventListener("resize", closeFilter));
const pageSize = computed(() => (props.profile === "lookup" ? 20 : 10));
let anchor = -1;
function pick(id: string, index: number, event: Event) {
  if (!props.multiple) {
    emit("select", id);
    return;
  }
  const next = new Set(props.selectedIds);
  const checked = !next.has(id);
  const range =
    (event as MouseEvent).shiftKey && anchor >= 0
      ? rows.value.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
      : rows.value.slice(index, index + 1);
  range.forEach((entry) =>
    checked ? next.add(entry.id) : next.delete(entry.id),
  );
  anchor = index;
  emit("changeSelection", [...next]);
}
watch(page, () => {
  anchor = -1;
});
const pages = computed(() =>
  Math.max(1, Math.ceil(candidates.value.length / pageSize.value)),
);
const rows = computed(() =>
  candidates.value.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
);
watch([query, filters], () => {
  page.value = 1;
  anchor = -1;
});
watch(
  () => rows.value.map((entry) => entry.id).join(","),
  () => {
    anchor = -1;
  },
);
watch(pages, (count) => (page.value = Math.min(page.value, count)));
</script>
<template>
  <div class="selection-records">
    <div class="relation-picker-toolbar">
      <span>{{
        data.forms.find((form) => form.id === config.formId)?.title
      }}</span>
      <div class="toolbar-spacer" />
      <div class="search-input">
        <AppIcon name="search" /><input
          v-model="query"
          aria-label="搜索数据"
          placeholder="搜索数据"
        />
      </div>
      <button
        v-if="profile === 'lookup'"
        ref="filterTrigger"
        type="button"
        class="text-button selection-filter-trigger"
        :class="{ active: filters.length }"
        :aria-expanded="filterOpen"
        aria-label="筛选数据"
        @click="showFilter"
      >
        <AppIcon name="filter" :size="14" />筛选
      </button>
    </div>
    <div class="relation-picker-scroll">
      <table class="relation-table">
        <thead>
          <tr>
            <th v-if="selectable">选择</th>
            <th v-for="field in columns" :key="field.id">
              {{ config.columnLabels?.[field.id] || field.pathLabel
              }}<AppIcon
                v-if="
                  filters.some((filter) => filter.sourceFieldId === field.id)
                "
                name="filter"
                :size="12"
                class="selection-filter-marker"
              />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(entry, index) in rows"
            :key="entry.id"
            :class="{
              selected: multiple
                ? selectedIds.includes(entry.id)
                : selectedId === entry.id,
            }"
            @click="selectable && pick(entry.id, index, $event)"
          >
            <td v-if="selectable">
              <input
                :type="multiple ? 'checkbox' : 'radio'"
                :name="radioGroup"
                :checked="
                  multiple
                    ? selectedIds.includes(entry.id)
                    : selectedId === entry.id
                "
                :aria-label="`选择记录 ${columns[0] ? selectionDisplayValue(columns[0], entry, data) : index + 1}`"
                @click.stop="multiple && pick(entry.id, index, $event)"
                @change="!multiple && pick(entry.id, index, $event)"
              />
            </td>
            <td v-for="field in columns" :key="field.id">
              {{ selectionDisplayValue(field, entry, data) }}
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td
              :colspan="columns.length + (selectable ? 1 : 0) || 1"
              class="relation-empty"
            >
              暂无符合条件的数据
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="relation-pagination">
      <span>{{
        filters.length || query.trim()
          ? `${candidates.length} 条 / 共 ${baseline.length} 条`
          : `共 ${candidates.length} 条`
      }}</span>
      <div class="toolbar-spacer" />
      <button
        type="button"
        class="icon-button"
        :disabled="page === 1"
        aria-label="数据上一页"
        @click="page--"
      >
        <AppIcon name="back" /></button
      ><span>{{ page }} / {{ pages }}</span
      ><button
        type="button"
        class="icon-button"
        :disabled="page === pages"
        aria-label="数据下一页"
        @click="page++"
      >
        <AppIcon name="right" />
      </button>
    </div>
  </div>
  <Teleport to="body">
    <div
      v-if="filterOpen"
      ref="filterPanel"
      role="dialog"
      aria-label="筛选数据"
      class="selection-filter-panel"
      :style="{ ...filterPosition, zIndex }"
    >
      <DataFilterEditor
        v-model="filterDraft"
        :source-fields="filterFields"
        :local-fields="[]"
        :constant-options="filterOptions"
        constant-only
        compact
        source-placeholder="请选择字段"
      />
      <p v-if="filterError" class="field-error" role="alert">
        {{ filterError }}
      </p>
      <div class="selection-filter-footer">
        <button type="button" class="button primary" @click="applyFilters">
          筛选</button
        ><button type="button" class="text-button" @click="clearFilters">
          <AppIcon name="trash" :size="14" />清空
        </button>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
.selection-records {
  min-width: 0;
}
.relation-picker-toolbar {
  flex-wrap: wrap;
}
.search-input {
  max-width: 100%;
}
.search-input input {
  min-width: 0;
}
.relation-table td {
  max-width: 240px;
  overflow-wrap: anywhere;
}
.selection-filter-trigger {
  margin: 0;
}
.selection-filter-trigger.active,
.selection-filter-marker {
  color: var(--primary);
}
.selection-filter-marker {
  vertical-align: middle;
  margin-left: 6px;
}
.selection-filter-panel {
  position: fixed;
  width: 640px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: white;
  box-shadow: 0 3px 14px #26344524;
  padding: 12px;
}
.selection-filter-panel :deep(.data-filter-editor) {
  max-height: 40vh;
  overflow: auto;
}
.selection-filter-footer {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
@media (max-width: 600px) {
  .relation-picker-toolbar > span {
    width: 100%;
  }
  .relation-picker-toolbar .toolbar-spacer {
    display: none;
  }
  .search-input {
    flex: 1;
  }
}
</style>
