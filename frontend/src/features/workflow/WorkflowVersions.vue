<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from "vue";
import type { ProcessTemplateVersionSummary } from "@platform/contracts";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";

const props = defineProps<{
  versions: ProcessTemplateVersionSummary[];
  draftVersion: number;
  selectedVersion: number;
  busy: boolean;
  dirty: boolean;
}>();
const emit = defineEmits<{
  select: [version: number];
  create: [version: number];
  activate: [version: number];
  remove: [version: number];
}>();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const menuId = useId();
const menuOpen = ref(false);
const managing = ref(false);
const confirmation = ref<{ kind: "activate" | "remove"; version: number }>();
const orderedVersions = computed(() =>
  [...props.versions].sort((a, b) => b.version - a.version),
);
const displayedVersion = computed(
  () => props.selectedVersion || props.draftVersion,
);
const currentVersion = computed(() =>
  props.versions.find((version) => version.version === props.selectedVersion),
);

function closeMenu(restoreFocus = false) {
  menuOpen.value = false;
  if (restoreFocus) trigger.value?.focus();
}
async function openMenu(last = false) {
  if (props.busy) return;
  menuOpen.value = true;
  await nextTick();
  const items = menu.value?.querySelectorAll<HTMLButtonElement>(
    "button:not(:disabled)",
  );
  if (items?.length) items[last ? items.length - 1 : 0]?.focus();
}
function toggleMenu() {
  if (menuOpen.value) closeMenu(true);
  else void openMenu();
}
function menuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
    return;
  }
  if (event.key === "Tab") {
    // 焦点先回到触发按钮，再由浏览器按正常顺序前进或后退。
    closeMenu(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!menuOpen.value) {
    void openMenu(event.key === "ArrowUp" || event.key === "End");
    return;
  }
  const items = [
    ...(menu.value?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ) || []),
  ];
  if (!items.length) return;
  const current = items.findIndex((item) => item === document.activeElement);
  let index = current + (event.key === "ArrowUp" ? -1 : 1);
  if (event.key === "Home") index = 0;
  if (event.key === "End") index = items.length - 1;
  items[(index + items.length) % items.length]?.focus();
}
function outsideClick(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target))
    closeMenu();
}
onMounted(() => document.addEventListener("pointerdown", outsideClick));
onBeforeUnmount(() =>
  document.removeEventListener("pointerdown", outsideClick),
);
watch(
  () => props.busy,
  (busy) => {
    if (busy) closeMenu();
  },
);

function select(version: number) {
  if (props.busy) return;
  closeMenu(true);
  managing.value = false;
  emit("select", version);
}
function create(version: number) {
  if (props.busy || version === 0) return;
  closeMenu(true);
  managing.value = false;
  emit("create", version);
}
function manage() {
  closeMenu(true);
  managing.value = true;
}
function requestAction(
  kind: "activate" | "remove",
  version: ProcessTemplateVersionSummary,
) {
  if (props.busy) return;
  if (kind === "activate" && version.active) return;
  if (kind === "remove" && !version.canDelete) return;
  closeMenu(true);
  confirmation.value = { kind, version: version.version };
}
function confirmAction() {
  if (props.busy || !confirmation.value) return;
  const action = confirmation.value;
  const version = props.versions.find(
    (item) => item.version === action.version,
  );
  confirmation.value = undefined;
  // 确认期间版本可能已刷新，沿用最新的启用和删除资格。
  if (!version) return;
  // 操作结果由画布页统一显示，避免管理弹窗挡住失败原因。
  managing.value = false;
  if (action.kind === "activate" && !version.active)
    emit("activate", version.version);
  if (action.kind === "remove" && version.canDelete)
    emit("remove", version.version);
}
function createdAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<template>
  <div ref="root" class="workflow-versions" @keydown.stop="menuKeydown">
    <button
      ref="trigger"
      type="button"
      class="version-trigger"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :aria-controls="menuId"
      :disabled="busy"
      :title="
        selectedVersion
          ? '已发布版本只读，点击编辑此版本可修改设计稿'
          : undefined
      "
      @click="toggleMenu"
    >
      流程版本（V{{ displayedVersion }}）
      <span v-if="!selectedVersion" class="version-tag draft">设计中</span>
      <span v-else-if="currentVersion?.active" class="version-tag active"
        >启用中</span
      >
      <span v-else class="version-tag">历史</span>
      <span
        v-if="dirty"
        class="dirty-dot"
        role="img"
        aria-label="设计中版本有未保存修改"
        title="设计中版本有未保存修改"
      />
      <AppIcon name="down" :size="14" />
    </button>
    <div
      v-if="menuOpen"
      :id="menuId"
      ref="menu"
      class="version-menu"
      role="menu"
      aria-label="流程版本"
    >
      <div class="version-menu-list">
        <button
          type="button"
          class="version-row"
          :class="{ selected: selectedVersion === 0 }"
          role="menuitemradio"
          tabindex="-1"
          :aria-checked="selectedVersion === 0"
          @click="select(0)"
        >
          <strong>V{{ draftVersion }}</strong>
          <span class="version-tag draft">设计中</span>
          <AppIcon
            v-if="selectedVersion === 0"
            name="check"
            class="selection-check"
          />
        </button>
        <button
          v-for="version in orderedVersions"
          :key="version.version"
          type="button"
          class="version-row"
          :class="{ selected: selectedVersion === version.version }"
          role="menuitemradio"
          tabindex="-1"
          :aria-checked="selectedVersion === version.version"
          @click="select(version.version)"
        >
          <strong>V{{ version.version }}</strong>
          <span v-if="version.active" class="version-tag active">启用中</span>
          <span v-else class="version-tag">历史版本</span>
          <AppIcon
            v-if="selectedVersion === version.version"
            name="check"
            class="selection-check"
          />
        </button>
      </div>
      <div class="version-menu-footer" role="none">
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          :disabled="selectedVersion === 0"
          :title="selectedVersion === 0 ? '当前正在设计新版本' : undefined"
          @click="create(selectedVersion)"
        >
          <AppIcon name="add" />添加新版本
        </button>
        <button type="button" role="menuitem" tabindex="-1" @click="manage">
          <AppIcon name="settings" />管理已有版本
        </button>
      </div>
    </div>
  </div>

  <BaseDialog
    :open="managing"
    title="管理流程版本"
    width="760px"
    :busy="busy"
    @close="managing = false"
  >
    <div class="version-manager-draft">
      <div>
        <strong>V{{ draftVersion }}</strong
        ><span class="version-tag draft">设计中</span
        ><span v-if="dirty" class="version-draft-hint">有未保存修改</span>
      </div>
      <button type="button" class="text-button" @click="select(0)">
        查看设计稿
      </button>
    </div>
    <div v-if="orderedVersions.length" class="version-table-wrap">
      <table class="version-table">
        <thead>
          <tr>
            <th>版本</th>
            <th>创建时间</th>
            <th>已发起流程</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="version in orderedVersions"
            :key="version.version"
            :class="{ selected: selectedVersion === version.version }"
          >
            <td>
              <strong>V{{ version.version }}</strong
              ><span v-if="version.active" class="version-tag active"
                >启用中</span
              >
            </td>
            <td>{{ createdAt(version.createdAt) }}</td>
            <td>{{ version.processCount }}</td>
            <td>
              <div class="version-actions">
                <button
                  type="button"
                  :aria-label="`查看 V${version.version}`"
                  @click="select(version.version)"
                >
                  查看
                </button>
                <button
                  type="button"
                  :aria-label="`基于 V${version.version} 新建`"
                  @click="create(version.version)"
                >
                  基于此版新建
                </button>
                <button
                  v-if="!version.active"
                  type="button"
                  :aria-label="`启用 V${version.version}`"
                  @click="requestAction('activate', version)"
                >
                  启用
                </button>
                <button
                  v-if="version.canDelete"
                  type="button"
                  class="delete-action"
                  :aria-label="`删除 V${version.version}`"
                  @click="requestAction('remove', version)"
                >
                  删除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="version-empty">暂无已发布版本。</p>
    <p class="version-help">
      启用后，新发起的流程使用该版本；已有流程继续使用原版本。
    </p>
    <template #footer>
      <button type="button" class="button" @click="managing = false">
        关闭
      </button>
      <button
        type="button"
        class="button primary"
        :disabled="selectedVersion === 0"
        :title="selectedVersion === 0 ? '当前正在设计新版本' : undefined"
        @click="create(selectedVersion)"
      >
        <AppIcon name="add" />添加新版本
      </button>
    </template>
  </BaseDialog>

  <BaseDialog
    :open="!!confirmation"
    :title="confirmation?.kind === 'remove' ? '删除流程版本' : '启用流程版本'"
    width="420px"
    :busy="busy"
    @close="confirmation = undefined"
  >
    <p v-if="confirmation?.kind === 'remove'" class="version-confirmation">
      确定删除 V{{ confirmation.version }}？删除后不可恢复。
    </p>
    <p v-else-if="confirmation" class="version-confirmation">
      启用 V{{ confirmation.version }}
      后，新发起的流程将使用此版本。已有流程保持不变。
    </p>
    <template #footer>
      <button type="button" class="button" @click="confirmation = undefined">
        取消
      </button>
      <button
        type="button"
        class="button"
        :class="confirmation?.kind === 'remove' ? 'delete-button' : 'primary'"
        @click="confirmAction"
      >
        {{ confirmation?.kind === "remove" ? "删除版本" : "启用版本" }}
      </button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.workflow-versions {
  position: relative;
  flex-shrink: 0;
}
.version-trigger {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-radius: 4px;
  white-space: nowrap;
  font-size: 13px;
}
.version-trigger:hover:not(:disabled),
.version-trigger[aria-expanded="true"] {
  background: #edf2f7;
}
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e69b32;
}
.version-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 80;
  width: min(240px, calc(100vw - 32px));
  border: 1px solid #dfe5ef;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 8px 28px #23354d24;
  overflow: hidden;
}
.version-menu-list {
  max-height: min(360px, 55vh);
  overflow-y: auto;
}
.version-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 15px;
  text-align: left;
}
.version-row:hover,
.version-row:focus-visible {
  background: #f4f7fa;
}
.version-row.selected,
.version-table tr.selected {
  background: #f0faf8;
}
.selection-check {
  margin-left: auto;
  color: var(--teal);
}
.version-row strong,
.version-table strong,
.version-manager-draft strong {
  font-size: 13px;
  font-weight: 500;
}
.version-tag {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 3px;
  background: #f1f3f7;
  color: #7b8798;
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
}
.version-tag.active {
  color: #00a99d;
  background: #e5f6f2;
}
.version-tag.draft {
  color: #b47c24;
  background: #fff5df;
}
.version-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px 14px;
}
.version-actions button {
  padding: 2px 0;
  color: var(--teal);
  font-size: 12px;
  white-space: nowrap;
}
.version-actions button:hover {
  text-decoration: underline;
}
.version-actions .delete-action {
  color: #d95555;
}
.version-menu-footer {
  border-top: 1px solid #edf0f5;
  display: flex;
  flex-direction: column;
  padding: 5px;
}
.version-menu-footer button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-radius: 3px;
  color: #42516a;
  font-size: 13px;
  text-align: left;
}
.version-menu-footer button:hover,
.version-menu-footer button:focus-visible {
  background: #f3f6fa;
}
.version-manager-draft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  margin-bottom: 18px;
  padding: 13px 15px;
  border: 1px solid #e4e9f1;
  border-radius: 5px;
  background: #f8fafc;
}
.version-manager-draft > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.version-draft-hint {
  color: #b47c24;
  font-size: 12px;
}
.version-table-wrap {
  max-height: 430px;
  overflow: auto;
}
.version-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}
.version-table th {
  padding: 11px 10px;
  background: #f5f7fa;
  color: #8591a4;
  font-weight: 500;
  white-space: nowrap;
}
.version-table td {
  padding: 14px 10px;
  border-bottom: 1px solid #edf0f5;
}
.version-table td:first-child {
  white-space: nowrap;
}
.version-table td:nth-child(2) {
  color: #8591a4;
  white-space: nowrap;
}
.version-table .version-tag {
  margin-left: 6px;
}
.version-help,
.version-empty {
  margin: 16px 0 0;
  color: #8591a4;
  font-size: 12px;
  line-height: 1.7;
}
.version-empty {
  padding: 24px;
  text-align: center;
}
.version-confirmation {
  margin: 0;
  line-height: 1.8;
}
.delete-button {
  color: #fff;
  background: #dc5555;
  border-color: #dc5555;
}
.delete-button:hover:not(:disabled) {
  background: #c44747;
  border-color: #c44747;
}
</style>
