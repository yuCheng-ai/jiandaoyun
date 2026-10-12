<script setup lang="ts">
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/minimap/dist/style.css";
import "./workflow.css";
import {
  ref,
  computed,
  onMounted,
  onBeforeUnmount,
  nextTick,
  watch,
} from "vue";
import { VueFlow, useVueFlow, type Connection } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { MiniMap } from "@vue-flow/minimap";
import AppIcon from "../../components/AppIcon.vue";
import WorkflowNode from "../../components/WorkflowNode.vue";
import PluginEditor from "../extensions/components/PluginEditor.vue";
import RunTrace from "../extensions/components/RunTrace.vue";
import {
  newInvocation,
  runPlugin,
  sampleValues,
  type PluginInvocation,
  type ExtensionRun,
} from "../../domain/extensions";
import { emptySchema, type FormValues } from "../../domain/form";
import PropertyPanel from "../../components/PropertyPanel.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import ShortcutPopover from "../../components/ShortcutPopover.vue";
import OrganizationPicker from "../../components/organization/OrganizationPicker.vue";
import { identityLabel, resolveIdentities } from "../../domain/organization";
import { useRoute, useRouter } from "vue-router";
import { useWorkspaceStore, syncFormWorkflow } from "../../stores/workspace";
import DesignerHeader from "../../components/shared/DesignerHeader.vue";
import { useWorkflow } from "../../composables/useWorkflow";
import {
  kindLabels,
  validate,
  serialize,
  simulationPath,
  clone,
  type NodeKind,
  type ValidationIssue,
} from "../../domain/workflow";

const pageRoute = useRoute(),
  router = useRouter(),
  workspace = useWorkspaceStore();
const formId = String(pageRoute.params.formId);
const currentForm = workspace.openForm(formId);
const {
  doc,
  selectedId,
  selectedEdgeId,
  selected,
  dirty,
  savedTime,
  canUndo,
  canRedo,
  undo,
  redo,
  select,
  add,
  updateNode,
  copySelection,
  pasteSelection,
  removeSelected,
  connect,
  save,
  replace,
  layout,
  checkpoint,
  loadError,
} = useWorkflow(
  currentForm
    ? {
        initial: currentForm.workflow,
        onChange: (value) => {
          currentForm.workflow = value;
          currentForm.title = value.title;
        },
        onSave: async (value) => {
          currentForm.workflow = value;
          currentForm.title = value.title;
          syncFormWorkflow(currentForm);
          return await workspace.saveForm(formId);
        },
      }
    : undefined,
);
const {
  setViewport,
  zoomIn,
  zoomOut,
  fitView,
  viewport,
  removeSelectedElements,
} = useVueFlow("designer");
const canvas = ref<HTMLElement>(),
  fileInput = ref<HTMLInputElement>();
const shortcutPosition = ref<{ left: number; top: number } | null>(null);
const spacePanning = ref(false);
const modifierKey = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
function toggleShortcuts(event: MouseEvent) {
  if (shortcutPosition.value) {
    shortcutPosition.value = null;
    return;
  }
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const toolbarBottom = (event.currentTarget as HTMLElement)
    .closest(".toolbar")!
    .getBoundingClientRect().bottom;
  shortcutPosition.value = {
    left: Math.max(
      16,
      Math.min(bounds.left + bounds.width / 2 - 262, window.innerWidth - 540),
    ),
    top: toolbarBottom + 4,
  };
  picker.value = null;
}
function closeShortcuts() {
  shortcutPosition.value = null;
}
function releasePan(event?: KeyboardEvent) {
  if (!event || event.code === "Space") spacePanning.value = false;
}
function cancelSelection() {
  selectedId.value = "";
  selectedEdgeId.value = null;
  removeSelectedElements();
}
const panelTab = ref("node"),
  showMinimap = ref(false),
  showOutline = ref(false),
  showInspector = ref(true);
const dialog = ref("");
const pluginOpen = ref(false),
  pluginTrial = ref<ExtensionRun>(),
  forcePluginFailure = ref(false),
  testValues = ref<FormValues>({});
function applyPlugin(config: PluginInvocation) {
  if (!selected.value || selected.value.data.kind !== "plugin") return false;
  updateNode(selectedId.value, {
    plugin: config.actionId,
    pluginConfig: config,
  });
  notify("动作配置已应用，请保存流程");
  return true;
}
function openPlugin() {
  pluginOpen.value = true;
}

const timeoutHours = ref(24),
  timeoutAction = ref("remind"),
  timeoutEnabled = ref(true);
const notices = ref<
  { id: number; message: string; type: "success" | "warning" }[]
>([]);
const noticeTimers = new Set<ReturnType<typeof setTimeout>>();
const picker = ref<{
  x: number;
  y: number;
  anchor: string;
  direction: "before" | "after";
} | null>(null);
const issues = ref<ValidationIssue[]>([]),
  testAmount = ref(6000),
  testRunning = ref(false),
  testIndex = ref(-1);
const records = ref<
  { time: string; title: string; nodes: number; amount: number }[]
>([]);
const sampleForm = ref({
  applicant: "张三",
  department: "产品部",
  date: new Date().toLocaleDateString("en-CA"),
  amount: 6000,
  note: "",
});
const previewKey = ref(0);
const previewNodes = computed(() =>
  doc.value.nodes.map((n) => ({
    ...clone(n),
    selected: false,
    draggable: false,
    selectable: false,
  })),
);
const previewEdges = computed(() =>
  doc.value.edges.map((e) => ({ ...clone(e), selected: false })),
);
const route = computed(() =>
  simulationPath(
    doc.value,
    testRunning.value ? testValues.value : testAmount.value,
  ),
);
const finished = computed(
  () => testIndex.value >= route.value.length - 1 && testIndex.value >= 0,
);
function memberName(id: string) {
  return identityLabel(workspace.data.organization, id);
}
const nodeKinds: NodeKind[] = [
  "approval",
  "copy",
  "condition",
  "subflow",
  "plugin",
];
const dialogTitles: Record<string, string> = {
  members: "选择成员或部门",
  timeout: "节点限时处理",
  preview: "流程预览",
  test: "流程测试",
  activate: "启用流程",
  help: "操作指南",
  form: "表单设计",
  extensions: "扩展功能",
  publish: "表单发布",
  records: "记录管理",
  notes: "流程说明",
  files: "当前表单",
  notifications: "通知中心",
  export: "导出流程 JSON",
};
function notify(message: string, type: "success" | "warning" = "success") {
  const id = Date.now() + Math.random();
  notices.value.push({ id, message, type });
  const timer = setTimeout(() => {
    notices.value = notices.value.filter((n) => n.id !== id);
    noticeTimers.delete(timer);
  }, 3600);
  noticeTimers.add(timer);
}
async function saveFlow() {
  if (await save()) {
    notify("流程已保存到当前浏览器");
    return true;
  } else notify(workspace.storageError || "保存未完成，当前设计已保留，请重试。", "warning");
  return false;
}
async function saveNotes() {
  if (await saveFlow()) dialog.value = "";
}
function openDialog(name: string) {
  const routes: Record<string, string> = {
    form: "design",
    extensions: "extensions",
    publish: "publish",
    records: "data",
  };
  if (routes[name]) {
    router.push(
      `/apps/${pageRoute.params.appId}/forms/${formId}/${routes[name]}`,
    );
    return;
  }
  picker.value = null;
  closeShortcuts();
  dialog.value = name;
  if (name === "preview") previewKey.value++;
  if (name === "test" || name === "activate" || name === "publish") {
    issues.value = validate(
      doc.value,
      workspace.data.organization,
      currentForm?.schema,
    );
    testRunning.value = false;
    testIndex.value = -1;
  }
}
function pickNode(id: string) {
  select(id);
  panelTab.value = "node";
  showInspector.value = true;
}
function openPicker(
  id: string,
  direction: "before" | "after",
  event: MouseEvent,
) {
  picker.value = {
    x: Math.max(12, Math.min(event.clientX + 12, window.innerWidth - 210)),
    y: Math.max(100, Math.min(event.clientY + 10, window.innerHeight - 274)),
    anchor: id,
    direction,
  };
}
function addPicked(kind: NodeKind) {
  if (picker.value) add(kind, picker.value.anchor, picker.value.direction);
  picker.value = null;
  panelTab.value = "node";
}
function addToolbar(kind: NodeKind) {
  add(kind);
  panelTab.value = "node";
  notify(`已添加${kindLabels[kind]}`);
}
function handleConnect(connection: Connection) {
  const error = connect(connection);
  if (error) notify(error, "warning");
}
function openMembers() {
  openDialog("members");
}
function confirmMembers(ids: string[]) {
  updateNode(selectedId.value, { members: ids });
  dialog.value = "";
}
function openTimeout() {
  timeoutEnabled.value = !!selected.value?.data.timeout;
  timeoutHours.value = selected.value?.data.timeout || 24;
  timeoutAction.value = selected.value?.data.timeoutAction || "remind";
  openDialog("timeout");
}
function confirmTimeout() {
  if (
    timeoutEnabled.value &&
    (!Number.isFinite(timeoutHours.value) ||
      timeoutHours.value < 1 ||
      timeoutHours.value > 8760)
  ) {
    notify("处理时限应在 1 至 8760 小时之间", "warning");
    return;
  }
  updateNode(selectedId.value, {
    timeout: timeoutEnabled.value ? timeoutHours.value : 0,
    timeoutAction: timeoutAction.value,
  });
  dialog.value = "";
}
function exportFlow() {
  openDialog("export");
}
async function copyExport() {
  const textbox = document.querySelector<HTMLTextAreaElement>(".json-output");
  textbox?.focus();
  textbox?.select();
  try {
    if (document.execCommand("copy")) {
      notify("流程 JSON 已复制");
      return;
    }
    await navigator.clipboard.writeText(
      JSON.stringify(JSON.parse(serialize(doc.value)), null, 2),
    );
    notify("流程 JSON 已复制");
  } catch {
    notify("JSON 已选中，请按 ⌘ C 或 Ctrl C 复制", "warning");
  }
}
function downloadFlow() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(JSON.parse(serialize(doc.value)), null, 2)], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${doc.value.title || "流程"}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("已请求下载流程文件；也可直接复制 JSON");
}
async function importFlow(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 2_000_000)
      throw new Error("文件过大，请选择 2 MB 以内的流程文件");
    replace(await file.text());
    await nextTick();
    fitView({ padding: 0.25, duration: 300 });
    notify("流程已导入，可撤销本次操作");
  } catch (error) {
    notify(
      error instanceof Error ? error.message : "无法读取流程文件",
      "warning",
    );
  } finally {
    input.value = "";
  }
}
async function activate() {
  issues.value = validate(
    doc.value,
    workspace.data.organization,
    currentForm?.schema,
  );
  if (issues.value.length) return;
  doc.value.enabled = true;
  if (!(await save())) {
    doc.value.enabled = false;
    notify("保存失败，流程尚未启用", "warning");
    return;
  }
  dialog.value = "";
  notify("流程已启用，配置已保存");
}
function handleIssue(issue: ValidationIssue) {
  if (issue.nodeId) {
    pickNode(issue.nodeId);
    dialog.value = "";
    fitView({ nodes: [issue.nodeId], maxZoom: 1, duration: 300 });
  }
}
function startTest() {
  issues.value = validate(
    doc.value,
    workspace.data.organization,
    currentForm?.schema,
  );
  if (issues.value.length) return;
  testValues.value = currentForm ? sampleValues(currentForm.schema) : {};
  for (const node of doc.value.nodes.filter((n) => n.data.kind === "condition"))
    testValues.value[node.data.conditionFieldId || "amount"] = testAmount.value;
  pluginTrial.value = undefined;
  testRunning.value = true;
  testIndex.value = 0;
}
async function nextStep() {
  if (finished.value) return;
  const node = route.value[testIndex.value];
  if (node?.data.kind === "plugin") {
    const previous = pluginTrial.value;
    pluginTrial.value = runPlugin(
      node.data.pluginConfig || newInvocation(node.data.plugin),
      currentForm?.schema || emptySchema(),
      testValues.value,
      workspace.data,
      forcePluginFailure.value,
      node.id,
    );
    if (previous?.status === "failed") pluginTrial.value.retryOf = previous.id;
    await workspace.recordExtensionRun(pluginTrial.value, formId);
    if (pluginTrial.value.status !== "success") return;
    Object.assign(testValues.value, pluginTrial.value.mappedValues);
  }
  testIndex.value++;
  if (finished.value) {
    records.value.unshift({
      time: new Date().toLocaleString("zh-CN"),
      title: doc.value.title,
      nodes: route.value.length,
      amount: testAmount.value,
    });
    notify("模拟流程已完成");
  }
}
function resetView() {
  const width = canvas.value?.clientWidth || 1100;
  setViewport({ x: width / 2 - 88, y: 0, zoom: 1 }, { duration: 250 });
}
async function autoLayout(horizontal = false) {
  layout(horizontal);
  await nextTick();
  fitView({ padding: 0.3, maxZoom: 1, duration: 300 });
  notify(horizontal ? "已按水平方向排列" : "已自动整理流程");
}
function keyboard(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && key === "s") {
    event.preventDefault();
    saveFlow();
    return;
  }
  const target = event.target as HTMLElement;
  if (
    dialog.value ||
    /INPUT|TEXTAREA|SELECT/.test(target.tagName) ||
    target.isContentEditable
  )
    return;
  if (event.code === "Space" && !modifier) {
    event.preventDefault();
    spacePanning.value = true;
    return;
  }
  if (key === "escape") {
    event.preventDefault();
    picker.value = null;
    closeShortcuts();
    cancelSelection();
    releasePan();
    return;
  }
  if (key === "delete" || key === "backspace") {
    event.preventDefault();
    removeSelected();
    return;
  }
  if (!modifier || event.altKey) return;
  if (key === "z") {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
  } else if (key === "y") {
    event.preventDefault();
    redo();
  } else if (key === "c") {
    event.preventDefault();
    notify(copySelection());
  } else if (key === "v") {
    event.preventDefault();
    const error = pasteSelection();
    if (error) notify(error, "warning");
    else {
      panelTab.value = "node";
      notify("已粘贴，拖动连接点可接入流程");
    }
  } else if (key === "+" || key === "=" || event.code === "NumpadAdd") {
    event.preventDefault();
    zoomIn({ duration: 150 });
  } else if (key === "-" || event.code === "NumpadSubtract") {
    event.preventDefault();
    zoomOut({ duration: 150 });
  } else if (key === "0") {
    event.preventDefault();
    fitView({ padding: 0.3, maxZoom: 1, duration: 250 });
  }
}
function editorClipboardEvent(event: ClipboardEvent) {
  const target = event.target as HTMLElement;
  if (
    dialog.value ||
    /INPUT|TEXTAREA|SELECT/.test(target.tagName) ||
    target.isContentEditable
  )
    return;
  if (event.type === "copy") {
    if (window.getSelection()?.toString()) return;
    const message = copySelection();
    if (!message.startsWith("已复制")) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", message);
    notify(message);
  } else {
    const error = pasteSelection();
    if (error) return;
    event.preventDefault();
    panelTab.value = "node";
    notify("已粘贴，拖动连接点可接入流程");
  }
}
function releasePanOnBlur() {
  releasePan();
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault();
}
watch(
  () => doc.value.title,
  (title) => (document.title = `${title || "未命名表单"} · 流程设计器`),
  { immediate: true },
);
onMounted(() => {
  window.addEventListener("keydown", keyboard, true);
  window.addEventListener("copy", editorClipboardEvent);
  window.addEventListener("paste", editorClipboardEvent);
  window.addEventListener("keyup", releasePan);
  window.addEventListener("blur", releasePanOnBlur);
  window.addEventListener("resize", closeShortcuts);
  window.addEventListener("beforeunload", beforeUnload);
  if (loadError) notify(loadError, "warning");
  if (
    typeof pageRoute.query.node === "string" &&
    doc.value.nodes.some((n) => n.id === pageRoute.query.node)
  )
    pickNode(pageRoute.query.node);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", keyboard, true);
  window.removeEventListener("copy", editorClipboardEvent);
  window.removeEventListener("paste", editorClipboardEvent);
  window.removeEventListener("keyup", releasePan);
  window.removeEventListener("blur", releasePanOnBlur);
  window.removeEventListener("resize", closeShortcuts);
  window.removeEventListener("beforeunload", beforeUnload);
  noticeTimers.forEach(clearTimeout);
});
</script>

<template>
  <div
    class="application"
    @click="
      picker = null;
      closeShortcuts();
    "
  >
    <DesignerHeader
      v-model:title="doc.title"
      :app-id="String(pageRoute.params.appId)"
      :form-id="formId"
      active="flow"
      @help="openDialog('help')"
    />
    <main class="designer-shell">
      <div class="toolbar" role="toolbar" aria-label="流程设计工具">
        <div class="toolbar-tools">
          <div class="tool-group history-tools">
            <button
              class="icon-button"
              title="撤销（⌘ Z）"
              aria-label="撤销"
              :disabled="!canUndo"
              @click="undo"
            >
              <AppIcon name="undo" :size="15" /></button
            ><button
              class="icon-button"
              :title="`重做（${modifierKey} Y）`"
              aria-label="重做"
              :disabled="!canRedo"
              @click="redo"
            >
              <AppIcon name="redo" :size="15" />
            </button>
          </div>
          <span class="toolbar-divider" />
          <button
            v-for="kind in [
              'approval',
              'copy',
              'subflow',
              'plugin',
            ] as NodeKind[]"
            :key="kind"
            class="node-tool"
            :title="`添加${kindLabels[kind]}`"
            @click="addToolbar(kind)"
          >
            <AppIcon :name="kind" :class="kind" :size="16" /><span>{{
              kindLabels[kind]
            }}</span>
          </button>
          <span class="toolbar-divider" /><button
            class="icon-button"
            aria-label="自动整理"
            title="自动整理"
            @click="autoLayout()"
          >
            <AppIcon name="align" /></button
          ><button
            class="icon-button"
            aria-label="水平排列"
            title="水平排列"
            @click="autoLayout(true)"
          >
            <AppIcon name="horizontal" /></button
          ><span class="toolbar-divider" />
          <button
            class="icon-button"
            aria-label="删除所选节点或连线"
            title="删除所选节点或连线（Delete）"
            :disabled="
              !selectedEdgeId &&
              (!selected || ['start', 'end'].includes(selected.data.kind))
            "
            @click="removeSelected"
          >
            <AppIcon name="trash" /></button
          ><button
            class="icon-button keyboard-tool"
            aria-label="快捷键"
            title="快捷键"
            :class="{ 'is-open': shortcutPosition }"
            :aria-expanded="!!shortcutPosition"
            aria-controls="shortcut-popover"
            @click.stop="toggleShortcuts"
          >
            <AppIcon name="keyboard" />
          </button>
        </div>
        <div class="toolbar-actions">
          <button
            class="version-button"
            :title="
              savedTime
                ? `上次保存 ${savedTime}${dirty ? '，有未保存修改' : ''}`
                : dirty
                  ? '尚未保存'
                  : '已保存到当前浏览器'
            "
            @click="
              panelTab = 'flow';
              showInspector = true;
            "
          >
            <span class="status-dot" :class="{ enabled: doc.enabled }" /><span
              >流程版本（V{{ doc.version }}）</span
            ></button
          ><button
            class="icon-button notes-button"
            title="流程说明"
            aria-label="流程说明"
            @click="openDialog('notes')"
          >
            <AppIcon name="comment" /></button
          ><button class="button outline" @click="openDialog('preview')">
            预览</button
          ><button class="button outline" @click="openDialog('test')">
            测试</button
          ><button class="button outline" @click="saveFlow">保存</button
          ><button
            class="button primary activate-button"
            :class="{ enabled: doc.enabled }"
            @click="openDialog('activate')"
          >
            {{ doc.enabled ? "已启用" : "启用流程" }}
          </button>
        </div>
      </div>
      <div class="designer-body">
        <section
          ref="canvas"
          class="canvas-area"
          :class="{ 'is-panning': spacePanning }"
          aria-label="流程画布"
        >
          <VueFlow
            id="designer"
            v-model:nodes="doc.nodes"
            v-model:edges="doc.edges"
            :min-zoom="0.25"
            :max-zoom="2"
            :delete-key-code="null"
            pan-activation-key-code="Space"
            :nodes-draggable="!spacePanning"
            :nodes-connectable="!spacePanning"
            :snap-to-grid="false"
            :connection-radius="28"
            :zoom-on-double-click="false"
            :default-viewport="{ x: 440, y: 0, zoom: 1 }"
            @init="resetView"
            @node-click="pickNode($event.node.id)"
            @edge-click="selectedEdgeId = $event.edge.id"
            @node-drag-start="checkpoint"
            @node-drag-stop="checkpoint"
            @connect="handleConnect"
            @pane-click="
              picker = null;
              selectedEdgeId = null;
            "
          >
            <Background :gap="24" :size="1.5" pattern-color="#dce1ec" />
            <template #node-workflow="props"
              ><WorkflowNode
                v-bind="props"
                :selected="
                  (selectedId === props.id || props.selected) && !selectedEdgeId
                "
                @add="openPicker"
            /></template>
            <MiniMap
              v-if="showMinimap"
              :pannable="true"
              :zoomable="true"
              :node-color="
                (node) =>
                  node.data.kind === 'start'
                    ? '#4eba66'
                    : node.data.kind === 'end'
                      ? '#9aa4b3'
                      : '#78a5ff'
              "
            />
          </VueFlow>
          <div class="canvas-view-toggle segmented">
            <button
              :class="{ active: !showOutline }"
              title="流程图"
              aria-label="流程图"
              @click="showOutline = false"
            >
              <AppIcon name="list" :size="18" /></button
            ><button
              :class="{ active: showOutline }"
              title="节点目录"
              aria-label="节点目录"
              @click="showOutline = !showOutline"
            >
              <AppIcon name="layers" :size="16" />
            </button>
          </div>
          <div v-if="showOutline" class="outline-panel">
            <div class="outline-heading">
              流程节点<button
                class="icon-button"
                aria-label="关闭目录"
                @click="showOutline = false"
              >
                <AppIcon name="close" :size="15" />
              </button>
            </div>
            <button
              v-for="node in doc.nodes"
              :key="node.id"
              :class="{ active: selectedId === node.id }"
              @click="
                pickNode(node.id);
                fitView({ nodes: [node.id], maxZoom: 1, duration: 200 });
              "
            >
              <AppIcon :name="node.data.kind" :class="node.data.kind" />{{
                node.data.label
              }}
            </button>
          </div>
          <button
            class="inspector-toggle icon-button"
            title="切换属性面板"
            aria-label="切换属性面板"
            @click="showInspector = !showInspector"
          >
            <AppIcon name="settings" />
          </button>
          <div class="canvas-controls">
            <div class="zoom-controls">
              <button
                class="icon-button"
                aria-label="缩小"
                title="缩小"
                @click="zoomOut({ duration: 200 })"
              >
                <AppIcon name="search" :size="15" /><AppIcon
                  class="zoom-symbol"
                  name="minus"
                  :size="6"
                /></button
              ><button
                class="zoom-label"
                title="重置为 100%"
                @click="resetView"
              >
                {{ Math.round(viewport.zoom * 100) }}%</button
              ><button
                class="icon-button"
                aria-label="放大"
                title="放大"
                @click="zoomIn({ duration: 200 })"
              >
                <AppIcon name="search" :size="15" /><AppIcon
                  class="zoom-symbol"
                  name="add"
                  :size="6"
                />
              </button>
            </div>
            <button
              class="icon-button fit-button"
              aria-label="适应画布"
              title="适应画布；双击显示缩略图"
              @click="fitView({ padding: 0.3, maxZoom: 1, duration: 250 })"
              @dblclick="showMinimap = !showMinimap"
            >
              <AppIcon name="locate" :size="18" />
            </button>
          </div>
        </section>
        <PropertyPanel
          v-if="showInspector"
          :node="selected"
          :document="doc"
          v-model:tab="panelTab"
          @update="updateNode(selectedId, $event)"
          @members="openMembers"
          @timeout="openTimeout"
          @export="exportFlow"
          @import="fileInput?.click()"
          @plugin="openPlugin"
        />
      </div>
    </main>
    <PluginEditor
      :open="pluginOpen"
      :model-value="selected?.data.pluginConfig"
      :legacy="selected?.data.plugin"
      :schema="currentForm?.schema || emptySchema()"
      :form-id="formId"
      :node-id="selectedId"
      :save-config="applyPlugin"
      @close="pluginOpen = false"
    />
    <ShortcutPopover
      v-if="shortcutPosition"
      v-bind="shortcutPosition"
      :modifier="modifierKey"
    />
    <div
      v-if="picker"
      class="node-picker"
      :style="{ left: `${picker.x}px`, top: `${picker.y}px` }"
      @click.stop
    >
      <div class="picker-heading">添加节点</div>
      <button v-for="kind in nodeKinds" :key="kind" @click="addPicked(kind)">
        <span class="picker-icon" :class="kind"
          ><AppIcon :name="kind" :size="18" /></span
        ><span>{{ kindLabels[kind] }}</span
        ><AppIcon name="add" :size="15" />
      </button>
    </div>
    <div class="toast-stack" aria-live="polite">
      <div
        v-for="notice in notices"
        :key="notice.id"
        class="toast"
        :class="notice.type"
      >
        <AppIcon
          :name="notice.type === 'success' ? 'success' : 'warning'"
          :size="19"
        />{{ notice.message }}
      </div>
    </div>
    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      class="visually-hidden"
      aria-label="导入流程文件"
      @change="importFlow"
    />

    <OrganizationPicker
      :open="dialog === 'members'"
      :model-value="selected?.data.members || []"
      kind="mixed"
      multiple
      title="选择节点负责人"
      @update:model-value="confirmMembers"
      @close="dialog = ''"
    />
    <BaseDialog
      :open="!!dialog && dialog !== 'members'"
      :title="dialogTitles[dialog] || ''"
      :width="
        dialog === 'preview' ? '920px' : dialog === 'test' ? '620px' : '520px'
      "
      @close="dialog = ''"
    >
      <template v-if="dialog === 'timeout'"
        ><label class="checkbox-line"
          ><input v-model="timeoutEnabled" type="checkbox" />启用限时处理</label
        >
        <div class="form-group dialog-field">
          <label for="timeout-hours">处理时限</label>
          <div class="input-suffix">
            <input
              id="timeout-hours"
              v-model.number="timeoutHours"
              type="number"
              min="1"
              max="8760"
              :disabled="!timeoutEnabled"
            /><span>小时</span>
          </div>
        </div>
        <div class="form-group">
          <label for="timeout-action">超时后执行</label>
          <div class="select-wrap">
            <select
              id="timeout-action"
              v-model="timeoutAction"
              :disabled="!timeoutEnabled"
            >
              <option value="remind">提醒节点负责人</option>
              <option value="approve">自动通过当前节点</option></select
            ><AppIcon name="down" />
          </div></div
      ></template>
      <template v-else-if="dialog === 'preview'"
        ><div class="preview-heading">
          <span>{{ doc.title }}</span
          ><span class="subtle"
            >{{ doc.nodes.length }} 个节点 · V{{ doc.version }}</span
          >
        </div>
        <div class="preview-canvas">
          <VueFlow
            :id="`preview-${previewKey}`"
            :key="previewKey"
            :nodes="previewNodes"
            :edges="previewEdges"
            fit-view-on-init
            :nodes-draggable="false"
            :nodes-connectable="false"
            :elements-selectable="false"
            :delete-key-code="null"
            :min-zoom="0.2"
            :max-zoom="1.5"
            ><Background
              :gap="24"
              :size="1.5"
              pattern-color="#dce1ec" /><template #node-workflow="props"
              ><WorkflowNode
                v-bind="props"
                readonly
                :selected="false" /></template
          ></VueFlow>
        </div>
        <p class="field-hint preview-hint">
          滚轮缩放，拖动空白区域查看完整流程。
        </p></template
      >
      <template v-else-if="['test', 'activate', 'publish'].includes(dialog)">
        <div v-if="issues.length" class="validation-summary warning">
          <AppIcon name="warning" :size="23" />
          <div>
            <strong>还有 {{ issues.length }} 项配置需要完善</strong>
            <p>
              完善以下配置后即可{{ dialog === "test" ? "测试" : "启用" }}流程。
            </p>
          </div>
        </div>
        <div v-if="issues.length" class="issue-list">
          <button
            v-for="(issue, index) in issues"
            :key="index"
            @click="handleIssue(issue)"
          >
            <span>{{ index + 1 }}. {{ issue.message }}</span
            ><AppIcon
              v-if="issue.nodeId"
              name="back"
              class="arrow-forward"
              :size="16"
            />
          </button>
        </div>
        <template v-else-if="dialog === 'test'"
          ><div v-if="!testRunning" class="test-intro">
            <AppIcon name="success" :size="28" />
            <div>
              <strong>流程校验通过</strong>
              <p>输入测试数据，逐步预演节点流转。</p>
            </div>
          </div>
          <div class="form-group">
            <label for="test-amount">申请金额</label>
            <div class="input-suffix">
              <input
                id="test-amount"
                v-model.number="testAmount"
                type="number"
                min="0"
                :disabled="testRunning"
              /><span>元</span>
            </div>
          </div>
          <div v-if="testRunning" class="simulation-list">
            <div
              v-for="(node, index) in route"
              :key="node.id"
              class="simulation-step"
              :class="{
                complete: index < testIndex || finished,
                current: index === testIndex && !finished,
              }"
            >
              <span class="step-icon"
                ><AppIcon
                  :name="
                    index < testIndex || finished ? 'check' : node.data.kind
                  "
                  :size="17"
              /></span>
              <div>
                <strong>{{ node.data.label }}</strong
                ><small>{{
                  index < testIndex || finished
                    ? "已完成"
                    : index === testIndex
                      ? "等待模拟处理"
                      : "待流转"
                }}</small>
              </div>
              <span v-if="node.data.members.length" class="step-assignees">{{
                node.data.members.map(memberName).join("、")
              }}</span>
            </div>
          </div>
          <label
            v-if="doc.nodes.some((n) => n.data.kind === 'plugin')"
            class="enable-config"
            ><input
              type="checkbox"
              v-model="forcePluginFailure"
            />模拟插件执行失败</label
          >
          <RunTrace
            v-if="pluginTrial"
            :run="pluginTrial"
            @locate="
              dialog = '';
              pickNode(pluginTrial.subjectId);
              pluginOpen = true;
            "
          />
          <div v-if="finished" class="inline-success">
            <AppIcon name="success" />流程已完成，测试记录已生成。
          </div>
          <p class="field-hint">
            本地转换会计算并回填测试副本；外部插件仅模拟响应，失败会停在当前节点。
          </p></template
        >
        <template v-else
          ><div class="activation-preview">
            <span class="activation-icon"
              ><AppIcon name="check" :size="28"
            /></span>
            <h3>{{ doc.enabled ? "流程已启用" : "流程配置已就绪" }}</h3>
            <p>
              {{ doc.title }} · {{ doc.nodes.length }} 个节点 · V{{
                doc.version
              }}
            </p>
          </div>
          <div class="helper-note">
            启用后将保存当前流程配置。修改配置会重新进入草稿状态；实际审批执行需接入后端服务。
          </div></template
        >
      </template>
      <template v-else-if="dialog === 'help'"
        ><p class="dialog-intro">在画布上搭建你的审批流程。</p>
        <div class="help-row">
          <span>添加节点</span>
          <p>点击顶部节点工具，或点击节点周围的加号。</p>
        </div>
        <div class="help-row">
          <span>连接节点</span>
          <p>从节点下方或侧面的连接点拖向另一节点上方。</p>
        </div>
        <div class="help-row">
          <span>移动与缩放</span>
          <p>拖动节点调整位置，拖动空白处平移，滚轮缩放。</p>
        </div>
        <div class="help-row"><span>保存</span><kbd>⌘ / Ctrl + S</kbd></div>
        <div class="help-row">
          <span>撤销 / 重做</span><kbd>⌘ Z / ⌘ Y（兼容 ⌘ ⇧ Z）</kbd>
        </div>
        <div class="help-row">
          <span>删除选中节点或连线</span><kbd>Delete / Backspace</kbd>
        </div>
        <p class="field-hint">
          配置保存在当前浏览器中，可通过流程属性导入、导出 JSON。
        </p></template
      >
      <template v-else-if="dialog === 'form'"
        ><p class="dialog-intro">{{ doc.title }} · 表单预览</p>
        <div class="form-grid">
          <div class="form-group">
            <label for="sample-applicant">申请人</label
            ><input id="sample-applicant" v-model="sampleForm.applicant" />
          </div>
          <div class="form-group">
            <label for="sample-department">申请部门</label
            ><input id="sample-department" v-model="sampleForm.department" />
          </div>
          <div class="form-group">
            <label for="sample-date">申请日期</label
            ><input id="sample-date" v-model="sampleForm.date" type="date" />
          </div>
          <div class="form-group">
            <label for="sample-amount">申请金额</label
            ><input
              id="sample-amount"
              v-model.number="sampleForm.amount"
              type="number"
              min="0"
            />
          </div>
        </div>
        <div class="form-group">
          <label for="sample-note">申请说明</label
          ><textarea id="sample-note" v-model="sampleForm.note" rows="3" />
        </div>
        <p class="field-hint">
          当前展示用于流程测试的示例表单。可在节点「字段权限」中设置各字段的访问权限。
        </p></template
      >
      <template v-else-if="dialog === 'extensions'"
        ><p class="dialog-intro">为流程添加自动化处理步骤。</p>
        <button
          v-for="item in [
            {
              name: '消息通知',
              icon: 'bell',
              detail: '节点流转后向成员发送提醒',
              value: 'notification',
            },
            {
              name: 'Webhook 请求',
              icon: 'code',
              detail: '将流程数据发送至外部系统',
              value: 'webhook',
            },
            {
              name: '更新表单数据',
              icon: 'document',
              detail: '在流程中自动更新业务数据',
              value: 'update',
            },
          ]"
          :key="item.value"
          class="extension-item"
          @click="
            addToolbar('plugin');
            updateNode(selectedId, { plugin: item.value, label: item.name });
            dialog = '';
          "
        >
          <span class="extension-icon"
            ><AppIcon :name="item.icon" :size="22" /></span
          ><span
            ><strong>{{ item.name }}</strong
            ><small>{{ item.detail }}</small></span
          ><AppIcon name="add" :size="18" />
        </button>
        <p class="field-hint">
          点击添加插件节点，配置可保存及导出，实际执行需连接服务端。
        </p></template
      >
      <template v-else-if="dialog === 'records'"
        ><p class="dialog-intro">本次会话的流程测试记录</p>
        <div v-if="!records.length" class="empty-state">
          <AppIcon name="document" :size="40" />
          <h3>暂无测试记录</h3>
          <p>运行一次完整流程测试后，记录会出现在这里。</p>
          <button class="button outline" @click="openDialog('test')">
            去测试流程
          </button>
        </div>
        <div v-else class="record-list">
          <div v-for="(record, index) in records" :key="index">
            <AppIcon name="success" class="teal" :size="20" />
            <div>
              <strong>{{ record.title }}</strong
              ><small
                >{{ record.time }} · {{ record.nodes }} 个节点 · ¥{{
                  record.amount
                }}</small
              >
            </div>
            <span class="record-status">已完成</span>
          </div>
        </div></template
      >
      <template v-else-if="dialog === 'notes'"
        ><label class="standalone-label" for="notes">流程说明</label
        ><textarea
          id="notes"
          v-model="doc.description"
          rows="6"
          placeholder="记录流程用途、审批规范或其他说明…"
        />
      </template>
      <template v-else-if="dialog === 'files'"
        ><div class="document-card">
          <AppIcon name="document" :size="34" />
          <div>
            <strong>{{ doc.title || "未命名表单" }}</strong>
            <p>
              {{ doc.nodes.length }} 个节点 ·
              {{ dirty ? "有未保存的修改" : "已保存到浏览器" }}
            </p>
          </div>
        </div>
        <div class="file-actions">
          <button class="button" @click="exportFlow">
            <AppIcon name="export" />导出流程</button
          ><button
            class="button"
            @click="
              fileInput?.click();
              dialog = '';
            "
          >
            <AppIcon name="import" />导入流程
          </button>
        </div></template
      >
      <template v-else-if="dialog === 'export'"
        ><p class="dialog-intro">
          完整配置包含节点、连线、负责人和流转规则，可再次导入。
        </p>
        <textarea
          class="json-output"
          aria-label="流程 JSON"
          :value="JSON.stringify(JSON.parse(serialize(doc)), null, 2)"
          readonly
          rows="16"
          spellcheck="false"
        />
      </template>
      <template v-else-if="dialog === 'notifications'"
        ><div class="empty-state">
          <AppIcon name="bell" :size="38" />
          <h3>暂无新通知</h3>
          <p>保存和流程测试的结果会即时在页面中提示。</p>
        </div></template
      >
      <template #footer>
        <template v-if="dialog === 'timeout'"
          ><button class="button" @click="dialog = ''">取消</button
          ><button class="button primary" @click="confirmTimeout">
            确定
          </button></template
        >
        <template v-else-if="dialog === 'test' && !issues.length"
          ><button class="button" @click="dialog = ''">关闭</button
          ><button
            v-if="!testRunning"
            class="button primary"
            :disabled="!Number.isFinite(testAmount) || testAmount < 0"
            @click="startTest"
          >
            <AppIcon name="start" />开始测试</button
          ><button
            v-else-if="!finished"
            class="button primary"
            @click="nextStep"
          >
            {{
              route[testIndex]?.data.kind === "approval"
                ? "模拟同意，继续流转"
                : "执行下一节点"
            }}</button
          ><button
            v-else
            class="button primary"
            @click="
              testRunning = false;
              testIndex = -1;
            "
          >
            重新测试
          </button></template
        >
        <template
          v-else-if="['activate', 'publish'].includes(dialog) && !issues.length"
          ><button class="button" @click="dialog = ''">关闭</button
          ><button v-if="!doc.enabled" class="button primary" @click="activate">
            确认启用
          </button></template
        >
        <template v-else-if="dialog === 'form'"
          ><button class="button" @click="dialog = ''">关闭</button
          ><button
            class="button primary"
            @click="
              testAmount = sampleForm.amount;
              openDialog('test');
            "
          >
            使用此数据测试
          </button></template
        >
        <template v-else-if="dialog === 'notes'"
          ><button class="button primary" @click="saveNotes">
            保存说明
          </button></template
        >
        <template v-else-if="dialog === 'export'"
          ><button class="button" @click="downloadFlow">
            <AppIcon name="export" />下载文件</button
          ><button class="button primary" @click="copyExport">
            复制 JSON
          </button></template
        >
        <template v-else
          ><button class="button" @click="dialog = ''">关闭</button
          ><button
            v-if="dialog === 'preview'"
            class="button primary"
            @click="exportFlow"
          >
            <AppIcon name="export" />导出流程
          </button></template
        >
      </template>
    </BaseDialog>
  </div>
</template>
