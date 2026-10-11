<script setup lang="ts">
import { useRuntimeData } from "../../../composables/useRuntimeData";
import {
  computed,
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import {
  formTitleLayout,
  fieldGridSpan,
  subformColumnWidth,
  subformFixedColumnIds,
  subformSummaryFields,
  maxSubformRows,
  subformRowCountIssue,
  subformRowId,
  subformPermissions,
  existingSubformRow,
  type FrontendFieldChange,
} from "@platform/contracts";
import { sanitizeRichText } from "../../../domain/richText";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import FieldControl from "./FieldControl.vue";
import FormTabBar from "./FormTabBar.vue";
import AppIcon from "../../../components/AppIcon.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import FieldDescription from "./FieldDescription.vue";
import SubformQuickFillDialog from "./SubformQuickFillDialog.vue";
import type { SubformFillMode } from "../../../domain/subformQuickFill";
import {
  runtimeDefaults,
  applyFieldChange,
  displayValue,
} from "../../../domain/relations";
import {
  flattenFields,
  isFieldVisible,
  uid,
  type FormField,
  type FormSchema,
  type FormValues,
  type FieldError,
} from "../../../domain/form";
const props = withDefaults(
  defineProps<{
    fields: FormField[];
    schema: FormSchema;
    values: FormValues;
    errors?: FieldError[];
    validationAttempt?: number;
    prefix?: string;
    disabled?: boolean;
    readonly?: boolean;
    editSerial?: boolean;
    entryId?: string;
    rowBaseline?: FormValues;
    existingRows?: FormValues;
    ignoreRowPermissions?: boolean;
    device?: "desktop" | "mobile";
    external?: boolean;
  }>(),
  { errors: () => [], validationAttempt: 0, prefix: "", disabled: false },
);
const emit = defineEmits<{
  change: [
    id: string,
    value: unknown,
    source?: FrontendFieldChange | FrontendFieldChange[],
    acknowledge?: (error?: string) => void,
  ];
  activate: [source: FrontendFieldChange];
}>();
const tabs = ref<Record<string, string>>({});
const runtimeData = useRuntimeData();
const media =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 650px)")
    : undefined;
const narrow = ref(media?.matches || false);
const resize = () => {
  narrow.value = media?.matches || false;
};
onMounted(() => media?.addEventListener("change", resize));
onBeforeUnmount(() => media?.removeEventListener("change", resize));
const mobile = computed(() =>
  props.device ? props.device === "mobile" : narrow.value,
);
const mobileVertical = (field: FormField) =>
  mobile.value &&
  field.type === "subform" &&
  field.subformMobile?.layout === "vertical";
const expandedMobileRows = ref(new Set<string>());
const mobileRowKey = (field: FormField, row: FormValues, index: number) =>
  `${field.id}:${subformRowId(field.id, row, index)}`;
const mobileExpanded = (field: FormField, row: FormValues, index: number) =>
  expandedMobileRows.value.has(mobileRowKey(field, row, index));
function toggleMobileRow(field: FormField, row: FormValues, index: number) {
  const key = mobileRowKey(field, row, index);
  if (expandedMobileRows.value.has(key)) expandedMobileRows.value.delete(key);
  else expandedMobileRows.value.add(key);
}
const allMobileExpanded = (field: FormField) =>
  !!rows(field.id).length &&
  rows(field.id).every((row, i) => mobileExpanded(field, row, i));
function toggleAllMobile(field: FormField) {
  const collapse = allMobileExpanded(field);
  rows(field.id).forEach((row, i) => {
    const key = mobileRowKey(field, row, i);
    if (collapse) expandedMobileRows.value.delete(key);
    else expandedMobileRows.value.add(key);
  });
}
const mobileSummary = (field: FormField, row: FormValues) =>
  subformSummaryFields(field)
    .filter((child) =>
      isFieldVisible(child, props.schema, { ...props.values, ...row }),
    )
    .map((child) => ({
      id: child.id,
      label: child.label,
      value: displayValue(child, row[child.id], runtimeData.value),
    }));
function rowFields(field: FormField, row: FormValues, index: number) {
  return field.children.map((child) => ({
    ...child,
    width: 12,
    editable: child.editable && rowChildEditable(field, child, row, index),
  }));
}
const rowSchema = computed(() => ({
  ...props.schema,
  settings: {
    ...props.schema.settings,
    layout: 1 as const,
    labelPosition: "top" as const,
    mobileLayout: {
      ...formTitleLayout(props.schema.settings, true),
      labelPosition: "top" as const,
    },
  },
}));
const layout = computed(() =>
  formTitleLayout(props.schema.settings, mobile.value),
);
const descriptionTip = computed(
  () =>
    layout.value.labelPosition === "left" &&
    layout.value.descriptionMode === "popover",
);
function canEditRows(field: FormField) {
  return !props.disabled && !props.readonly && field.editable;
}
function policy(field: FormField) {
  return props.ignoreRowPermissions
    ? { add: true, insert: true, editExisting: true, deleteExisting: true }
    : subformPermissions(field.subformPermissions);
}
function existing(field: FormField, row: FormValues, index: number) {
  return existingSubformRow(
    field.id,
    row,
    index,
    props.existingRows || props.rowBaseline || {},
  );
}
function canEditRow(field: FormField, row: FormValues, index: number) {
  return (
    canEditRows(field) &&
    (!existing(field, row, index) || policy(field).editExisting)
  );
}
function canDeleteRow(field: FormField, row: FormValues, index: number) {
  return (
    canEditRows(field) &&
    (!existing(field, row, index) || policy(field).deleteExisting)
  );
}
function rowChildEditable(
  field: FormField,
  child: FormField,
  row: FormValues,
  index: number,
) {
  if (props.ignoreRowPermissions || !child.rowEditAccess) return true;
  const mode = existing(field, row, index)
    ? "existing"
    : rows(field.id)
          .slice(index + 1)
          .some((later, offset) => existing(field, later, index + offset + 1))
      ? "insert"
      : "append";
  return child.rowEditAccess[mode];
}
function rowActions(field: FormField) {
  return (
    canEditRows(field) &&
    batch.value?.fieldId !== field.id &&
    (policy(field).add ||
      policy(field).insert ||
      !!mobileLookup(field) ||
      rows(field.id).some((row, i) => canDeleteRow(field, row, i)))
  );
}
function removeRow(field: FormField, index: number) {
  if (!canDeleteRow(field, rows(field.id)[index]!, index)) return;
  emit(
    "change",
    field.id,
    rows(field.id).filter((_, i) => i !== index),
  );
}
function rows(id: string): FormValues[] {
  return Array.isArray(props.values[id])
    ? (props.values[id] as FormValues[])
    : [];
}
const batch = ref<{ fieldId: string; selected: string[] }>();
const quickFillId = ref("");
const quickFillField = computed(() =>
  flattenFields(props.fields).find((field) => field.id === quickFillId.value),
);
function quickFillEnabled(field: FormField) {
  return (
    field.subformQuickFill === true &&
    canEditRows(field) &&
    policy(field).add &&
    policy(field).editExisting &&
    rendered(field)
  );
}
function quickEditable(
  field: FormField,
  child: FormField,
  row: FormValues,
  index: number,
  mode: SubformFillMode,
) {
  return (
    quickFillEnabled(field) &&
    child.editable &&
    !child.masked &&
    (mode === "add"
      ? props.ignoreRowPermissions || child.rowEditAccess?.append !== false
      : canEditRow(field, row, index) &&
        rowChildEditable(field, child, row, index) &&
        isFieldVisible(child, props.schema, { ...props.values, ...row }))
  );
}
async function applyQuickFill(
  next: FormValues[],
  changes: FrontendFieldChange[],
  respond: (error?: string) => void,
) {
  const field = quickFillField.value;
  if (!field || !quickFillEnabled(field)) {
    respond("明细权限已变化，请重新打开快速填报");
    return;
  }
  let acknowledged = false,
    issue = "";
  emit("change", field.id, next, changes, (error) => {
    acknowledged = true;
    issue = error || "";
  });
  await nextTick();
  if (
    issue ||
    (!acknowledged && JSON.stringify(rows(field.id)) !== JSON.stringify(next))
  ) {
    respond(issue || "回填未完成，填写内容已保留，请处理表单提示后重试");
    return;
  }
  quickFillId.value = "";
}
function deletableIds(field: FormField) {
  return rows(field.id).flatMap((row, index) =>
    canDeleteRow(field, row, index) ? [subformRowId(field.id, row, index)] : [],
  );
}
function selectRows(field: FormField, ids: string[], checked: boolean) {
  if (batch.value?.fieldId !== field.id) return;
  const allowed = deletableIds(field);
  const selected = new Set(batch.value.selected);
  for (const id of ids) {
    if (checked && allowed.includes(id)) selected.add(id);
    else selected.delete(id);
  }
  batch.value.selected = [...selected];
}
function deleteSelected(field: FormField) {
  if (batch.value?.fieldId !== field.id || !batch.value.selected.length) return;
  const allowed = deletableIds(field);
  if (batch.value.selected.some((id) => !allowed.includes(id))) return;
  const selected = new Set(batch.value.selected);
  emit(
    "change",
    field.id,
    rows(field.id).filter(
      (row, index) => !selected.has(subformRowId(field.id, row, index)),
    ),
  );
  batch.value = undefined;
}
const detail = ref<{ fieldId: string; rowId: string }>();
const detailMaximized = ref(false);
const detailField = computed(() =>
  props.fields.find(
    (field) => field.id === detail.value?.fieldId && rendered(field),
  ),
);
const detailIndex = computed(() =>
  detailField.value
    ? rows(detailField.value.id).findIndex(
        (row, index) =>
          subformRowId(detailField.value!.id, row, index) ===
          detail.value?.rowId,
      )
    : -1,
);
const detailRow = computed(() =>
  detailField.value && detailIndex.value >= 0
    ? rows(detailField.value.id)[detailIndex.value]
    : undefined,
);
const detailFields = computed(() => {
  const field = detailField.value,
    row = detailRow.value;
  return field && row ? rowFields(field, row, detailIndex.value) : [];
});
function openDetail(field: FormField, index: number) {
  detail.value = {
    fieldId: field.id,
    rowId: subformRowId(field.id, rows(field.id)[index]!, index),
  };
  detailMaximized.value = false;
}
function moveDetail(offset: number) {
  if (!detailField.value) return;
  const next = detailIndex.value + offset;
  if (next >= 0 && next < rows(detailField.value.id).length)
    detail.value = {
      fieldId: detailField.value.id,
      rowId: subformRowId(
        detailField.value.id,
        rows(detailField.value.id)[next]!,
        next,
      ),
    };
}
async function addDetail(copied = false) {
  const field = detailField.value;
  if (!field || !policy(field).add) return;
  const id = await addRow(
    field,
    rows(field.id).length,
    false,
    copied ? detailRow.value : undefined,
  );
  if (id && rows(field.id).some((row) => row._rowId === id))
    detail.value = { fieldId: field.id, rowId: id };
}
watch(
  () => {
    const field = props.fields.find(
      (field) => field.id === batch.value?.fieldId && rendered(field),
    );
    return field && canEditRows(field) ? deletableIds(field) : undefined;
  },
  (allowed) => {
    if (batch.value) {
      if (!allowed) batch.value = undefined;
      else
        batch.value.selected = batch.value.selected.filter((id) =>
          allowed.includes(id),
        );
    }
  },
  { deep: true },
);
watch(
  () => [detailField.value?.id, detailIndex.value],
  () => {
    if (detail.value && (!detailField.value || !detailRow.value))
      detail.value = undefined;
  },
);
function mobileLookup(parent: FormField) {
  if (!mobile.value || props.readonly || !parent.editable) return;
  const choices = parent.children.filter(
    (child) =>
      child.type === "lookup" &&
      child.visible &&
      child.editable &&
      child.referenceFormId,
  );
  // Keep separate controls if a row has multiple independent selectors.
  return choices.length === 1 ? choices[0] : undefined;
}
function rowLookup(parent: FormField, row: FormValues, child?: FormField) {
  const lookup = mobileLookup(parent);
  return canEditRow(parent, row, rows(parent.id).indexOf(row)) &&
    lookup &&
    isFieldVisible(lookup, props.schema, { ...props.values, ...row }) &&
    (!child ||
      lookup.reference.mappings.some(
        (mapping) => mapping.targetFieldId === child.id,
      ))
    ? lookup
    : undefined;
}
function chooseRow(parent: FormField, index: number, child?: FormField) {
  const lookup = rowLookup(parent, rows(parent.id)[index] || {}, child);
  if (lookup)
    emit("activate", {
      fieldId: lookup.id,
      row: { subformId: parent.id, index },
    });
}
async function addRow(
  field: FormField,
  index = rows(field.id).length,
  insert = false,
  copied?: FormValues,
) {
  if (
    !canEditRows(field) ||
    !(insert ? policy(field).insert : policy(field).add) ||
    rows(field.id).length >= maxSubformRows
  )
    return;
  const row = {
    ...runtimeDefaults(
      field.children,
      runtimeData.value,
      props.values,
      props.schema.fields,
    ),
    ...(copied
      ? Object.fromEntries(
          field.children
            .filter(
              (child) =>
                child.editable &&
                (props.ignoreRowPermissions ||
                  child.rowEditAccess?.[
                    rows(field.id)
                      .slice(index)
                      .some((value, offset) =>
                        existing(field, value, index + offset),
                      )
                      ? "insert"
                      : "append"
                  ] !== false) &&
                !child.masked &&
                !["calculated", "serial"].includes(child.type),
            )
            .map((child) => [
              child.id,
              JSON.parse(JSON.stringify(copied[child.id] ?? "")),
            ]),
        )
      : {}),
    _rowId: uid("row"),
  };
  const next = [...rows(field.id)];
  next.splice(index, 0, row);
  menuRow.value = undefined;
  emit("change", field.id, next);
  await nextTick();
  const addedIndex = rows(field.id).findIndex(
    (value) => value._rowId === row._rowId,
  );
  if (addedIndex < 0) return;
  if (!detail.value) {
    if (mobileVertical(field))
      expandedMobileRows.value.add(mobileRowKey(field, row, addedIndex));
    else if (mobile.value && !mobileLookup(field))
      openDetail(field, addedIndex);
    chooseRow(field, addedIndex);
  }
  return row._rowId;
}
const menuRow = ref<{ field: FormField; index: number }>(),
  menuPanel = ref<HTMLElement>(),
  menuTrigger = ref<HTMLElement>();
const menuPosition = ref({ left: "0px", top: "0px" });
const { zIndex: menuZIndex } = useDialogLayer(
  menuPanel,
  () => (menuRow.value = undefined),
  () => {},
  { modal: false, anchor: () => menuTrigger.value },
);
async function openRowMenu(field: FormField, index: number, event: MouseEvent) {
  menuTrigger.value = event.currentTarget as HTMLElement;
  const rect = menuTrigger.value.getBoundingClientRect();
  menuPosition.value = {
    left: `${Math.max(12, Math.min(rect.right - 170, window.innerWidth - 182))}px`,
    top: `${Math.max(12, Math.min(rect.bottom + 4, window.innerHeight - 160))}px`,
  };
  menuRow.value = { field, index };
  await nextTick();
  menuPanel.value
    ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    ?.focus();
}
function rowMenuKey(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = Array.from(
    menuPanel.value?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ) || [],
  );
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length;
  buttons[index]?.focus();
}
const shownFields = (fields: FormField[], parent?: FormField) =>
  fields.filter(
    (field) =>
      (!props.readonly ||
        field.type !== "lookup" ||
        field.reference.displayColumns?.length) &&
      (!parent || mobileLookup(parent)?.id !== field.id),
  );
const subformColumns = (field: FormField) =>
  shownFields(field.children, field).filter((child) => child.visible);
const fixedColumnLayouts = computed(
  () =>
    new Map(
      props.fields
        .filter((field) => field.type === "subform")
        .map((field) => {
          const ids = subformFixedColumnIds(field, mobile.value);
          let left = 45;
          const columns = new Map<string, { left: string }>();
          for (const child of subformColumns(field))
            if (ids.has(child.id) && !child.masked) {
              columns.set(child.id, { left: `${left}px` });
              left += subformColumnWidth(child);
            }
          return [field.id, columns];
        }),
    ),
);
const fixedColumnStyle = (field: FormField, id: string) =>
  fixedColumnLayouts.value.get(field.id)?.get(id);
const hasFixedColumns = (field: FormField) =>
  !!fixedColumnLayouts.value.get(field.id)?.size;
const subformTableWidth = (field: FormField) =>
  subformColumns(field).reduce(
    (total, child) => total + subformColumnWidth(child),
    45,
  ) + (rowActions(field) ? (mobileLookup(field) ? 100 : 72) : 0);
function availableTabs(field: FormField) {
  return field.tabs.filter((item) =>
    shownFields(field.children).some(
      (child) => (!child.tabId || child.tabId === item.id) && rendered(child),
    ),
  );
}
function rendered(field: FormField): boolean {
  if (!isFieldVisible(field, props.schema, props.values)) return false;
  if (field.type !== "tabs") return true;
  if (field.tabs.length) return availableTabs(field).length > 0;
  // Preserve old unassigned controls without changing their schema or values.
  return shownFields(field.children).some(
    (child) => !child.tabId && rendered(child),
  );
}
function activeTab(field: FormField) {
  const available = availableTabs(field);
  return available.some((item) => item.id === tabs.value[field.id])
    ? tabs.value[field.id]
    : available[0]?.id;
}
watch(
  () =>
    props.fields
      .filter((field) => field.type === "tabs")
      .map((field) => ({
        id: field.id,
        available: availableTabs(field).map((item) => item.id),
      })),
  (containers) => {
    for (const { id, available } of containers) {
      if (tabs.value[id] && !available.includes(tabs.value[id]!)) {
        if (available[0]) tabs.value[id] = available[0];
        else delete tabs.value[id];
      }
    }
  },
);
watch(
  () => props.validationAttempt,
  () => {
    for (const field of props.fields.filter((item) => item.type === "tabs")) {
      const available = availableTabs(field);
      const first = shownFields(field.children).find(
        (child) =>
          rendered(child) &&
          child.tabId &&
          available.some((item) => item.id === child.tabId) &&
          flattenFields([child]).some((node) =>
            props.errors.some(
              (error) =>
                error.fieldId === node.id &&
                error.path.startsWith(props.prefix),
            ),
          ),
      );
      if (first?.tabId) tabs.value[field.id] = first.tabId;
    }
  },
  { immediate: true },
);
function changeRow(
  field: FormField,
  index: number,
  id: string,
  value: unknown,
) {
  const row = rows(field.id)[index];
  if (!row || !canEditRow(field, row, index)) return;
  const child = field.children.find((child) => child.id === id);
  if (
    !child ||
    !child.editable ||
    child.masked ||
    !rowChildEditable(field, child, rows(field.id)[index]!, index)
  )
    return;
  const next = rows(field.id).map((row, i) =>
    i === index
      ? applyFieldChange(
          field.children,
          row,
          id,
          value,
          runtimeData.value,
          props.values,
          props.schema.fields,
        )
      : row,
  );
  emit("change", field.id, next, {
    fieldId: id,
    row: { subformId: field.id, index },
  });
}
function error(id: string) {
  return props.errors.find((e) => e.path === props.prefix + id)?.message;
}
watch(
  () => [
    props.validationAttempt,
    mobile.value,
    ...props.fields.filter(mobileVertical).map((field) => field.id),
  ],
  () => {
    for (const field of props.fields.filter(mobileVertical))
      rows(field.id).forEach((row, index) => {
        if (
          props.errors.some((error) =>
            error.path.startsWith(`${props.prefix}${field.id}.${index}.`),
          )
        )
          expandedMobileRows.value.add(mobileRowKey(field, row, index));
      });
  },
  { immediate: true },
);
watch(
  () =>
    props.fields
      .filter((field) => field.type === "subform")
      .flatMap((field) =>
        rows(field.id).map((row, index) => mobileRowKey(field, row, index)),
      ),
  (keys) => {
    const active = new Set(keys);
    expandedMobileRows.value.forEach((key) => {
      if (!active.has(key)) expandedMobileRows.value.delete(key);
    });
  },
);
function buttonEnabled(field: FormField) {
  return (
    props.schema.settings.frontendEvents?.some(
      (event) =>
        event.enabled &&
        event.trigger === "field" &&
        event.fieldIds.includes(field.id),
    ) || false
  );
}
</script>
<template>
  <div
    class="runtime-fields"
    :class="{
      'labels-left': layout.labelPosition === 'left',
      'is-mobile': mobile,
      'labels-right': layout.labelAlignment === 'right',
      'inputs-auto': mobile || schema.settings.inputWidth === 'auto',
    }"
    :style="{ '--label-width': layout.labelWidth + 'px' }"
  >
    <template v-for="field in shownFields(fields)" :key="field.id"
      ><div
        v-if="rendered(field)"
        class="runtime-field"
        :class="{
          invalid: error(field.id),
          'container-field': ['tabs', 'subform'].includes(field.type),
          'divider-field': field.type === 'divider',
          'without-label': !field.showLabel,
        }"
        :style="{
          gridColumn: `span ${fieldGridSpan(field, schema.settings.layout)}`,
        }"
        :data-field-id="field.id"
      >
        <label
          v-if="
            field.showLabel &&
            !['divider', 'tabs'].includes(field.type) &&
            !mobileVertical(field)
          "
          class="runtime-label"
          ><span v-if="field.required" class="required">*</span>{{ field.label
          }}<FieldDescription
            v-if="field.description && descriptionTip"
            :label="field.label"
            :description="field.description"
        /></label>
        <div
          v-if="mobileVertical(field)"
          class="runtime-label subform-mobile-heading"
        >
          <span v-if="field.showLabel"
            ><span v-if="field.required" class="required">*</span
            >{{ field.label
            }}<FieldDescription
              v-if="field.description && descriptionTip"
              :label="field.label"
              :description="field.description"
          /></span>
          <span v-else />
          <div class="subform-mobile-toolbar">
            <button
              v-if="
                canEditRows(field) &&
                (policy(field).add ||
                  (policy(field).insert && !rows(field.id).length))
              "
              type="button"
              class="icon-button"
              :aria-label="`新增${field.label}记录`"
              :disabled="rows(field.id).length >= maxSubformRows"
              @click="addRow(field, rows(field.id).length, !policy(field).add)"
            >
              <AppIcon name="add" />
            </button>
            <button
              type="button"
              class="text-button"
              :disabled="!rows(field.id).length"
              @click="toggleAllMobile(field)"
            >
              <AppIcon
                name="down"
                :class="{ 'is-open': allMobileExpanded(field) }"
              />{{ allMobileExpanded(field) ? "全部收起" : "全部展开" }}
            </button>
          </div>
        </div>
        <div class="runtime-field-content">
          <FieldDescription
            v-if="
              field.description &&
              descriptionTip &&
              (!field.showLabel || field.type === 'tabs') &&
              field.type !== 'divider'
            "
            :label="field.label"
            :description="field.description"
          />
          <div
            v-if="
              field.description &&
              layout.labelPosition === 'top' &&
              field.type !== 'divider'
            "
            class="field-description"
            v-html="sanitizeRichText(field.description)"
          />
          <FormTabBar
            v-if="field.type === 'tabs'"
            :items="availableTabs(field)"
            :model-value="activeTab(field)"
            :label="field.label"
            :appearance="field"
            variant="runtime"
            @select="(id) => (tabs[field.id] = id)"
          >
            <FormFields
              :fields="
                field.children.filter(
                  (child) => !child.tabId || child.tabId === activeTab(field),
                )
              "
              :schema="schema"
              :values="values"
              :errors="errors"
              :validation-attempt="validationAttempt"
              :prefix="prefix"
              :disabled="disabled || !field.editable"
              :readonly="readonly"
              :edit-serial="editSerial"
              :entry-id="entryId"
              :row-baseline="rowBaseline"
              :existing-rows="existingRows"
              :ignore-row-permissions="ignoreRowPermissions"
              :device="mobile ? 'mobile' : 'desktop'"
              :external="external"
              @change="
                (id, value, source, acknowledge) =>
                  emit('change', id, value, source, acknowledge)
              "
              @activate="emit('activate', $event)"
          /></FormTabBar>
          <div
            v-else-if="field.type === 'subform'"
            class="runtime-subform"
            :class="{ 'has-fixed-columns': hasFixedColumns(field) }"
          >
            <div
              v-if="!mobileVertical(field)"
              class="subform-scroll"
              tabindex="0"
              :aria-label="`${field.label}明细表格`"
            >
              <table :style="{ width: `${subformTableWidth(field)}px` }">
                <colgroup>
                  <col style="width: 45px" />
                  <col
                    v-for="child in subformColumns(field)"
                    :key="child.id"
                    :style="{ width: `${subformColumnWidth(child)}px` }"
                  />
                  <col
                    v-if="rowActions(field)"
                    :style="{ width: mobileLookup(field) ? '100px' : '72px' }"
                  />
                </colgroup>
                <thead>
                  <tr>
                    <th
                      class="row-number"
                      :class="{
                        'subform-fixed-column': hasFixedColumns(field),
                      }"
                      :style="
                        hasFixedColumns(field) ? { left: '0px' } : undefined
                      "
                    >
                      <input
                        v-if="batch?.fieldId === field.id"
                        type="checkbox"
                        :aria-label="`全选可删除的${field.label}`"
                        :checked="
                          !!deletableIds(field).length &&
                          deletableIds(field).every((id) =>
                            batch!.selected.includes(id),
                          )
                        "
                        :indeterminate="
                          !!batch.selected.length &&
                          batch.selected.length < deletableIds(field).length
                        "
                        :disabled="!deletableIds(field).length"
                        @change="
                          selectRows(
                            field,
                            deletableIds(field),
                            ($event.target as HTMLInputElement).checked,
                          )
                        "
                      />
                      <button
                        v-else-if="deletableIds(field).length"
                        type="button"
                        class="icon-button"
                        :aria-label="`批量删除${field.label}`"
                        title="批量删除"
                        @click="batch = { fieldId: field.id, selected: [] }"
                      >
                        <AppIcon name="trash" />
                      </button>
                      <template v-else>序号</template>
                    </th>
                    <th
                      v-for="child in subformColumns(field)"
                      :key="child.id"
                      :title="child.label"
                      :class="{
                        'subform-fixed-column': !!fixedColumnStyle(
                          field,
                          child.id,
                        ),
                      }"
                      :style="fixedColumnStyle(field, child.id)"
                    >
                      <span class="subform-column-heading">
                        <span
                          ><span v-if="child.required" class="required">*</span
                          >{{ child.label }}</span
                        >
                        <FieldDescription
                          v-if="child.description"
                          :label="child.label"
                          :description="child.description"
                        />
                      </span>
                    </th>
                    <th v-if="rowActions(field)" class="row-number" />
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(row, index) in rows(field.id)"
                    :key="subformRowId(field.id, row, index)"
                  >
                    <td
                      :class="{
                        'subform-fixed-column': hasFixedColumns(field),
                      }"
                      :style="
                        hasFixedColumns(field) ? { left: '0px' } : undefined
                      "
                    >
                      <input
                        v-if="batch?.fieldId === field.id"
                        type="checkbox"
                        :aria-label="`选择${field.label}第${index + 1}行`"
                        :checked="
                          batch.selected.includes(
                            subformRowId(field.id, row, index),
                          )
                        "
                        :disabled="!canDeleteRow(field, row, index)"
                        @change="
                          selectRows(
                            field,
                            [subformRowId(field.id, row, index)],
                            ($event.target as HTMLInputElement).checked,
                          )
                        "
                      />
                      <button
                        v-else-if="rowLookup(field, row)"
                        type="button"
                        class="text-button"
                        :aria-label="`选择${field.label}第${index + 1}行数据`"
                        @click="chooseRow(field, index)"
                      >
                        {{ index + 1 }}</button
                      ><button
                        v-else
                        type="button"
                        class="icon-button subform-expand-row"
                        :aria-label="`展开${field.label}第${index + 1}行`"
                        @click="openDetail(field, index)"
                      >
                        <span>{{ index + 1 }}</span
                        ><AppIcon name="expand" />
                      </button>
                    </td>
                    <td
                      v-for="child in subformColumns(field)"
                      :key="child.id"
                      :class="{
                        'subform-fixed-column': !!fixedColumnStyle(
                          field,
                          child.id,
                        ),
                      }"
                      :style="fixedColumnStyle(field, child.id)"
                    >
                      <button
                        v-if="
                          rowLookup(field, row, child) &&
                          isFieldVisible(child, schema, { ...values, ...row })
                        "
                        type="button"
                        class="subform-lookup-value"
                        :aria-label="`${field.label} 第${index + 1}行 ${child.label}，选择数据`"
                        @click="chooseRow(field, index, child)"
                      >
                        {{ displayValue(child, row[child.id], runtimeData) }}
                      </button>
                      <FieldControl
                        :fields="schema.fields"
                        :device="mobile ? 'mobile' : 'desktop'"
                        v-else-if="
                          isFieldVisible(child, schema, { ...values, ...row })
                        "
                        :field="child"
                        :values="{ ...values, ...row }"
                        :entry-id="entryId"
                        :model-value="row[child.id]"
                        :disabled="
                          disabled ||
                          batch?.fieldId === field.id ||
                          !canEditRow(field, row, index) ||
                          !rowChildEditable(field, child, row, index)
                        "
                        :readonly="readonly"
                        :auto-textarea="!mobile"
                        :edit-serial="editSerial"
                        :button-enabled="buttonEnabled(child)"
                        :label="`${field.label} 第${index + 1}行 ${child.label}`"
                        @update:model-value="
                          changeRow(field, index, child.id, $event)
                        "
                        @activate="
                          emit('activate', {
                            fieldId: child.id,
                            row: { subformId: field.id, index },
                          })
                        "
                      /><small
                        v-if="
                          errors.find(
                            (e) =>
                              e.path ===
                              `${prefix}${field.id}.${index}.${child.id}`,
                          )
                        "
                        class="field-error"
                        >{{
                          errors.find(
                            (e) =>
                              e.path ===
                              `${prefix}${field.id}.${index}.${child.id}`,
                          )?.message
                        }}</small
                      >
                    </td>
                    <td v-if="rowActions(field)" class="subform-row-actions">
                      <button
                        v-if="rowLookup(field, row)"
                        type="button"
                        class="icon-button"
                        :aria-label="`展开${field.label}第${index + 1}行`"
                        @click="openDetail(field, index)"
                      >
                        <AppIcon name="expand" />
                      </button>
                      <button
                        v-if="policy(field).add || policy(field).insert"
                        type="button"
                        class="icon-button"
                        :aria-label="`${field.label}第${index + 1}行操作`"
                        aria-haspopup="menu"
                        :aria-expanded="
                          menuRow?.field.id === field.id &&
                          menuRow.index === index
                        "
                        @click="openRowMenu(field, index, $event)"
                      >
                        <AppIcon name="more" />
                      </button>
                      <button
                        v-if="canDeleteRow(field, row, index)"
                        type="button"
                        class="icon-button"
                        :aria-label="`删除${field.label}第${index + 1}行`"
                        @click="removeRow(field, index)"
                      >
                        <AppIcon name="trash" />
                      </button>
                    </td>
                  </tr>
                  <tr v-if="!rows(field.id).length">
                    <td
                      :colspan="
                        subformColumns(field).length +
                        1 +
                        (rowActions(field) ? 1 : 0)
                      "
                      class="empty-subform"
                    >
                      暂无明细
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="subform-mobile-rows">
              <section
                v-for="(row, index) in rows(field.id)"
                :key="subformRowId(field.id, row, index)"
                class="subform-mobile-row"
              >
                <header>
                  <span class="subform-mobile-number">{{ index + 1 }}</span>
                  <div>
                    <button
                      v-if="rowActions(field)"
                      type="button"
                      class="text-button"
                      :aria-label="`${field.label}第${index + 1}行操作`"
                      @click="openRowMenu(field, index, $event)"
                    >
                      更多
                    </button>
                    <button
                      v-if="canDeleteRow(field, row, index)"
                      type="button"
                      class="text-button"
                      :aria-label="`删除${field.label}第${index + 1}行`"
                      @click="removeRow(field, index)"
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      class="text-button"
                      :aria-label="`${mobileExpanded(field, row, index) ? '收起' : '展开'}${field.label}第${index + 1}行`"
                      :aria-expanded="mobileExpanded(field, row, index)"
                      :aria-controls="
                        mobileExpanded(field, row, index)
                          ? `subform-mobile-${mobileRowKey(field, row, index)}`
                          : undefined
                      "
                      @click="toggleMobileRow(field, row, index)"
                    >
                      {{ mobileExpanded(field, row, index) ? "收起" : "展开"
                      }}<AppIcon
                        name="down"
                        :class="{
                          'is-open': mobileExpanded(field, row, index),
                        }"
                      />
                    </button>
                  </div>
                </header>
                <div
                  v-if="mobileExpanded(field, row, index)"
                  :id="`subform-mobile-${mobileRowKey(field, row, index)}`"
                  class="subform-mobile-body"
                >
                  <FormFields
                    :fields="rowFields(field, row, index)"
                    :schema="rowSchema"
                    :values="{ ...values, ...row }"
                    :errors="errors"
                    :validation-attempt="validationAttempt"
                    :prefix="`${prefix}${field.id}.${index}.`"
                    :disabled="disabled || !canEditRow(field, row, index)"
                    :readonly="readonly"
                    :edit-serial="editSerial"
                    :entry-id="entryId"
                    device="mobile"
                    :external="external"
                    @change="(id, value) => changeRow(field, index, id, value)"
                    @activate="
                      (source) =>
                        emit('activate', {
                          fieldId: source.fieldId,
                          row: { subformId: field.id, index },
                        })
                    "
                  />
                </div>
                <button
                  v-else
                  type="button"
                  class="subform-mobile-summary"
                  :aria-label="`查看${field.label}第${index + 1}行简报`"
                  @click="toggleMobileRow(field, row, index)"
                >
                  <span
                    v-for="item in mobileSummary(field, row)"
                    :key="item.id"
                    :title="`${item.label}：${item.value}`"
                    >{{ item.value }}</span
                  ><span v-if="!mobileSummary(field, row).length" class="muted"
                    >暂无内容</span
                  >
                </button>
              </section>
              <p v-if="!rows(field.id).length" class="empty-subform">
                暂无明细
              </p>
            </div>
            <div
              v-if="batch?.fieldId === field.id"
              class="subform-batch-actions"
            >
              <button type="button" class="button" @click="batch = undefined">
                取消操作
              </button>
              <button
                type="button"
                class="button"
                :disabled="!batch.selected.length"
                @click="deleteSelected(field)"
              >
                删除选中
              </button>
            </div>
            <button
              v-if="
                batch?.fieldId !== field.id &&
                canEditRows(field) &&
                (policy(field).add ||
                  (policy(field).insert && !rows(field.id).length))
              "
              type="button"
              class="text-button subform-add"
              :disabled="rows(field.id).length >= maxSubformRows"
              :title="
                rows(field.id).length >= maxSubformRows
                  ? `最多添加${maxSubformRows}行`
                  : undefined
              "
              @click="addRow(field, rows(field.id).length, !policy(field).add)"
            >
              <AppIcon name="add" />{{
                mobileVertical(field)
                  ? policy(field).add
                    ? "添加记录"
                    : "插入记录"
                  : `${policy(field).add ? "添加" : "插入"}${field.label}`
              }}
            </button>
            <button
              v-if="batch?.fieldId !== field.id && quickFillEnabled(field)"
              type="button"
              class="text-button subform-add"
              @click="quickFillId = field.id"
            >
              <AppIcon name="edit" />快速填报
            </button>
            <p
              v-if="
                !readonly &&
                subformRowCountIssue(
                  field,
                  rows(field.id).length,
                  Array.isArray(rowBaseline?.[field.id])
                    ? (rowBaseline![field.id] as unknown[]).length
                    : 0,
                )
              "
              class="field-error"
              role="alert"
            >
              {{ subformRowCountIssue(field, rows(field.id).length) }}
            </p>
          </div>
          <FieldControl
            :fields="schema.fields"
            :device="mobile ? 'mobile' : 'desktop'"
            v-else
            :field="field"
            :values="values"
            :entry-id="entryId"
            :model-value="values[field.id]"
            :disabled="disabled"
            :readonly="readonly"
            :edit-serial="editSerial"
            :button-enabled="buttonEnabled(field)"
            @update:model-value="emit('change', field.id, $event)"
            @activate="emit('activate', { fieldId: field.id })"
          />
          <div
            v-if="
              field.description &&
              (field.type === 'divider' ||
                (layout.labelPosition === 'left' && !descriptionTip))
            "
            class="field-description"
            v-html="sanitizeRichText(field.description)"
          />
          <p v-if="error(field.id)" class="field-error">
            {{ error(field.id) }}
          </p>
        </div>
      </div></template
    >
  </div>
  <SubformQuickFillDialog
    v-if="quickFillField"
    :field="quickFillField"
    :schema="schema"
    :values="values"
    :external="external"
    :enabled="quickFillEnabled(quickFillField)"
    :mobile="mobile"
    :editable="
      (child, row, index, mode) =>
        quickEditable(quickFillField!, child, row, index, mode)
    "
    @apply="applyQuickFill"
    @close="quickFillId = ''"
  />
  <BaseDialog
    :open="!!detailField && !!detailRow"
    :title="detailField?.label || '明细'"
    :modal="false"
    :width="detailMaximized ? 'calc(100vw - 32px)' : '420px'"
    :class-name="`subform-detail-dialog${detailMaximized ? ' is-maximized' : ''}`"
    @close="detail = undefined"
  >
    <template #header>
      <h2>{{ detailField?.label }}</h2>
      <div class="subform-detail-navigation">
        <button
          type="button"
          class="icon-button"
          aria-label="上一条明细"
          :disabled="detailIndex <= 0"
          @click="moveDetail(-1)"
        >
          <AppIcon name="back" />
        </button>
        <span
          >{{ detailIndex + 1 }}/{{
            detailField ? rows(detailField.id).length : 0
          }}</span
        >
        <button
          type="button"
          class="icon-button"
          aria-label="下一条明细"
          :disabled="
            !detailField || detailIndex >= rows(detailField.id).length - 1
          "
          @click="moveDetail(1)"
        >
          <AppIcon name="right" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="detailMaximized ? '还原明细窗口' : '放大明细窗口'"
          @click="detailMaximized = !detailMaximized"
        >
          <AppIcon :name="detailMaximized ? 'fit' : 'expand'" />
        </button>
      </div>
    </template>
    <FormFields
      v-if="detailField && detailRow"
      :fields="detailFields"
      :schema="rowSchema"
      :values="{ ...values, ...detailRow }"
      :errors="errors"
      :validation-attempt="validationAttempt"
      :prefix="`${prefix}${detailField.id}.${detailIndex}.`"
      :disabled="disabled || !canEditRow(detailField, detailRow, detailIndex)"
      :readonly="readonly"
      :edit-serial="editSerial"
      :entry-id="entryId"
      :device="mobile ? 'mobile' : 'desktop'"
      :external="external"
      @change="(id, value) => changeRow(detailField!, detailIndex, id, value)"
      @activate="
        (source) =>
          emit('activate', {
            fieldId: source.fieldId,
            row: { subformId: detailField!.id, index: detailIndex },
          })
      "
    />
    <template #footer>
      <button
        v-if="
          detailField && canEditRows(detailField) && policy(detailField).add
        "
        type="button"
        class="button"
        :disabled="rows(detailField.id).length >= maxSubformRows"
        @click="addDetail()"
      >
        新增
      </button>
      <button
        v-if="
          detailField && canEditRows(detailField) && policy(detailField).add
        "
        type="button"
        class="button"
        :disabled="rows(detailField.id).length >= maxSubformRows"
        @click="addDetail(true)"
      >
        复制
      </button>
      <button type="button" class="button primary" @click="detail = undefined">
        完成
      </button>
    </template>
  </BaseDialog>
  <Teleport to="body">
    <div
      v-if="menuRow"
      ref="menuPanel"
      class="subform-row-menu"
      role="menu"
      aria-label="明细行操作"
      :style="{ ...menuPosition, zIndex: menuZIndex }"
      @keydown="rowMenuKey"
    >
      <button
        v-if="policy(menuRow.field).insert"
        role="menuitem"
        :disabled="rows(menuRow.field.id).length >= maxSubformRows"
        @click="addRow(menuRow.field, menuRow.index, true)"
      >
        上方插入
      </button>
      <button
        v-if="policy(menuRow.field).insert"
        role="menuitem"
        :disabled="rows(menuRow.field.id).length >= maxSubformRows"
        @click="addRow(menuRow.field, menuRow.index + 1, true)"
      >
        下方插入
      </button>
      <button
        v-if="policy(menuRow.field).insert"
        role="menuitem"
        :disabled="rows(menuRow.field.id).length >= maxSubformRows"
        @click="
          addRow(
            menuRow.field,
            menuRow.index + 1,
            true,
            rows(menuRow.field.id)[menuRow.index],
          )
        "
      >
        复制到下一行
      </button>
      <button
        v-if="policy(menuRow.field).add"
        role="menuitem"
        :disabled="rows(menuRow.field.id).length >= maxSubformRows"
        @click="
          addRow(
            menuRow.field,
            rows(menuRow.field.id).length,
            false,
            rows(menuRow.field.id)[menuRow.index],
          )
        "
      >
        复制到末尾
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.subform-row-actions {
  padding-inline: 4px;
  white-space: nowrap;
}
.subform-row-menu {
  position: fixed;
  width: 170px;
  padding: 4px;
  background: #fff;
  border: 1px solid #dde3e8;
  border-radius: 4px;
  box-shadow: 0 5px 20px #1e293b22;
}
.subform-row-menu button {
  display: block;
  width: 100%;
  padding: 7px 10px;
  text-align: left;
  font-size: 13px;
  border-radius: 3px;
}
.subform-row-menu button:hover {
  background: #f3faf8;
  color: var(--teal);
}
.subform-row-menu button:disabled {
  color: #a4aab4;
}
</style>
