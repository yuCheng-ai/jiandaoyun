<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { FormField } from "../../../domain/form";
import AppIcon from "../../../components/AppIcon.vue";
import { useDialogLayer } from "../../../composables/useDialogLayer";
const props = defineProps<{
  columns: string[];
  labels?: Record<string, string>;
  fields: (FormField & { pathLabel: string })[];
}>();
const emit = defineEmits<{
  change: [columns: string[], labels: Record<string, string> | undefined];
}>();
const open = ref(false),
  search = ref(""),
  editing = ref(""),
  name = ref("");
const trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>();
const position = ref({ left: "0px", top: "0px" });
const ordered = computed(() =>
  [
    ...props.columns.map(
      (id) =>
        props.fields.find((field) => field.id === id) || {
          id,
          pathLabel: "字段已移除",
        },
    ),
    ...props.fields.filter((field) => !props.columns.includes(field.id)),
  ].filter((field) =>
    `${field.pathLabel} ${props.labels?.[field.id] || ""}`.includes(
      search.value,
    ),
  ),
);
const label = (id: string) =>
  props.labels?.[id] ||
  props.fields.find((field) => field.id === id)?.pathLabel ||
  "字段已移除";
function close() {
  applyName();
  open.value = false;
  editing.value = "";
}
const { zIndex } = useDialogLayer(panel, close, () => {}, {
  modal: false,
  anchor: () => trigger.value,
});
function show() {
  if (open.value) return close();
  const rect = trigger.value!.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(rect.right - 296, window.innerWidth - 304))}px`,
    top: `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 364))}px`,
  };
  search.value = "";
  open.value = true;
}
function change(columns: string[], labels = { ...props.labels }) {
  emit("change", columns, Object.keys(labels).length ? labels : undefined);
}
function toggle(id: string) {
  const labels = { ...props.labels };
  if (props.columns.includes(id)) {
    delete labels[id];
    change(
      props.columns.filter((value) => value !== id),
      labels,
    );
  } else change([...props.columns, id], labels);
}
function move(id: string, to: number) {
  const columns = [...props.columns],
    from = columns.indexOf(id);
  if (from < 0 || to < 0 || to >= columns.length || from === to) return;
  columns.splice(to, 0, columns.splice(from, 1)[0]!);
  change(columns);
}
async function rename(id: string) {
  name.value = label(id);
  editing.value = id;
  await nextTick();
  const input = panel.value?.querySelector<HTMLInputElement>(
    ".selection-column-name",
  );
  input?.focus();
  input?.select();
}
async function restoreRenameFocus(id: string) {
  await nextTick();
  [
    ...(panel.value?.querySelectorAll<HTMLElement>(".selection-column-row") ||
      []),
  ]
    .find((row) => row.dataset.columnId === id)
    ?.querySelector<HTMLButtonElement>("button")
    ?.focus();
}
function applyName(restoreFocus = false) {
  const id = editing.value;
  if (!id) return;
  const labels = { ...props.labels },
    value = name.value.trim();
  if (
    !value ||
    value === props.fields.find((field) => field.id === id)?.pathLabel
  )
    delete labels[id];
  else labels[id] = value;
  editing.value = "";
  change([...props.columns], labels);
  if (restoreFocus) void restoreRenameFocus(id);
}
function drag(id: string, event: DragEvent) {
  event.dataTransfer?.setData("application/x-selection-column", id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function drop(id: string, event: DragEvent) {
  move(
    event.dataTransfer?.getData("application/x-selection-column") || "",
    props.columns.indexOf(id),
  );
}
onMounted(() => window.addEventListener("resize", close));
onBeforeUnmount(() => window.removeEventListener("resize", close));
</script>
<template>
  <button
    ref="trigger"
    type="button"
    class="button full-width selection-column-trigger"
    :aria-expanded="open"
    aria-label="选择数据时的显示字段"
    @click="show"
  >
    显示 {{ columns.length }} 个字段<AppIcon name="down" :size="13" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      role="dialog"
      aria-label="显示字段"
      class="selection-column-panel"
      :style="{ ...position, zIndex }"
    >
      <div class="search-input">
        <AppIcon name="search" /><input
          v-model="search"
          aria-label="搜索显示字段"
          placeholder="搜索字段"
        />
      </div>
      <div class="selection-column-list">
        <div
          v-for="field in ordered"
          :key="field.id"
          :data-column-id="field.id"
          class="selection-column-row"
          @dragover.prevent
          @drop.prevent="drop(field.id, $event)"
        >
          <label>
            <input
              type="checkbox"
              :checked="columns.includes(field.id)"
              :aria-label="`显示字段 ${field.pathLabel}`"
              @change="toggle(field.id)"
            />
            <span v-if="editing !== field.id" :title="field.pathLabel">{{
              columns.includes(field.id) ? label(field.id) : field.pathLabel
            }}</span>
          </label>
          <input
            v-if="editing === field.id"
            v-model="name"
            class="selection-column-name"
            :aria-label="`显示名 ${field.pathLabel}`"
            maxlength="100"
            @keydown.enter.prevent="applyName(true)"
            @blur="applyName()"
          />
          <div
            v-else-if="columns.includes(field.id)"
            class="selection-column-actions"
          >
            <button
              type="button"
              class="icon-button"
              :aria-label="`改名 ${field.pathLabel}`"
              @click="rename(field.id)"
            >
              <AppIcon name="edit" :size="14" />
            </button>
            <button
              type="button"
              class="icon-button"
              draggable="true"
              :aria-label="`调整顺序 ${field.pathLabel}`"
              title="拖动调整顺序；方向键上下移动"
              @dragstart="drag(field.id, $event)"
              @keydown.up.prevent="
                move(field.id, columns.indexOf(field.id) - 1)
              "
              @keydown.down.prevent="
                move(field.id, columns.indexOf(field.id) + 1)
              "
            >
              <AppIcon name="align" :size="14" />
            </button>
          </div>
        </div>
        <p v-if="!ordered.length" class="field-hint">无匹配字段</p>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
.selection-column-trigger {
  justify-content: space-between;
}
.selection-column-panel {
  position: fixed;
  width: 296px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: white;
  box-shadow: 0 3px 14px #26344524;
  padding: 8px;
  font-size: 13px;
}
.search-input {
  flex-shrink: 0;
  width: 100%;
  margin-bottom: 6px;
}
.search-input input {
  width: 100%;
  min-width: 0;
}
.selection-column-list {
  max-height: 300px;
  overflow: auto;
}
.selection-column-row {
  display: flex;
  align-items: center;
  min-height: 32px;
  gap: 4px;
  padding: 2px 4px;
}
.selection-column-row:hover,
.selection-column-row:focus-within {
  background: var(--canvas);
}
.selection-column-row label {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 8px;
  min-width: 0;
  margin: 0;
  cursor: pointer;
}
.selection-column-row label span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.selection-column-row label:has(+ .selection-column-name) {
  flex: 0;
}
.selection-column-row input[type="checkbox"] {
  width: 14px;
  height: 14px;
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--primary);
}
.selection-column-actions {
  display: flex;
  opacity: 0;
}
.selection-column-row:hover .selection-column-actions,
.selection-column-row:focus-within .selection-column-actions {
  opacity: 1;
}
.selection-column-actions button {
  width: 22px;
  height: 24px;
}
.selection-column-actions button[draggable] {
  cursor: grab;
}
.selection-column-name {
  min-width: 0;
  width: 100%;
  height: 28px;
}
@media (hover: none) {
  .selection-column-actions {
    opacity: 1;
  }
}
</style>
