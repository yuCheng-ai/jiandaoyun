<script setup lang="ts">
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/minimap/dist/style.css";
import "./workflow.css";
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import {
  VueFlow,
  MarkerType,
  useVueFlow,
  type Connection,
  type Node,
  type Edge,
  type NodeMouseEvent,
} from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { MiniMap } from "@vue-flow/minimap";
import {
  composeFormSchema,
  processTemplateConnectionError,
  type DataModel,
  type FormField,
  type PageEditorData,
  type PageSummary,
  type ProcessTemplateDraft,
  type ProcessTemplateSpec,
  type ProcessTemplateTask,
  type ProcessTemplateVersionSummary,
  type PublishedProcessTemplate,
  type PublishedPage,
  type ServerOrganization,
} from "@platform/contracts";
import AppIcon from "../../components/AppIcon.vue";
import WorkflowNode from "../../components/WorkflowNode.vue";
import PropertyPanel from "../../components/PropertyPanel.vue";
import WorkflowVersions from "./WorkflowVersions.vue";
import ShortcutPopover from "../../components/ShortcutPopover.vue";
import DesignerHeader from "../../components/shared/DesignerHeader.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi } from "../../repositories/platformApi";
import { useNotices } from "../../stores/notices";

const route = useRoute();
const router = useRouter();
const { notify } = useNotices();
const appId = String(route.params.applicationId);
const pageId = String(route.params.pageId);
const page = ref<PageEditorData>();
const pages = ref<PageSummary[]>([]);
const organization = ref<ServerOrganization>();
const versions = ref<Record<string, { page: PublishedPage; model: DataModel }>>(
  {},
);
const saved = ref<ProcessTemplateDraft>();
const spec = ref<ProcessTemplateSpec>({ title: "", bindings: [], tasks: [] });
const selectedId = ref("start");
const loading = ref(true);
const busy = ref(false);
const pendingPages = ref(0);
const versionHistory = ref<ProcessTemplateVersionSummary[]>([]);
const selectedVersion = ref(0);
const creatingVersion = ref<number>();
const ready = computed(() => !!page.value?.draft.latestVersion);
const operationBusy = computed(() => busy.value || pendingPages.value > 0);
const editingLocked = computed(
  () =>
    loading.value ||
    !ready.value ||
    operationBusy.value ||
    selectedVersion.value > 0,
);
const error = ref("");
const helpOpen = ref(false);
const panelTab = ref("node");
const pageTitle = computed(() => page.value?.draft.title || "表单");
const formLinked = computed(
  () => !!saved.value?.startPageId || !route.query.templateId,
);
const selected = computed(() =>
  spec.value.tasks.find((task) => task.id === selectedId.value),
);
const { dirty, confirmLeave, confirmDiscard, discard, markSaved } =
  useDraftDismiss(
    () => !loading.value && selectedVersion.value === 0,
    () => spec.value,
    () => router.push(`/applications/${appId}?form=${pageId}`),
  );
onBeforeRouteLeave(() => !operationBusy.value && confirmLeave());
onBeforeRouteUpdate(() => !operationBusy.value && confirmLeave());
const {
  fitView,
  zoomIn,
  zoomOut,
  setViewport,
  viewport,
  screenToFlowCoordinate,
} = useVueFlow("designer");
const canvas = ref<HTMLElement>();
const selectedEdgeId = ref("");
const showInspector = ref(true);
const showOutline = ref(false);
const showMinimap = ref(false);
const previewOpen = ref(false);
const spacePanning = ref(false);
const modifierKey = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
const shortcutPosition = ref<{ left: number; top: number } | null>(null);
const nodeMenu = ref<{ left: number; top: number }>();
const nodeKinds = [
  { id: "approval", label: "流程节点" },
  { id: "copy", label: "抄送节点" },
] as const;
const draggedKind = ref<"approval" | "copy">();
const identity = () => `task_${crypto.randomUUID().replaceAll("-", "")}`;

// 撤销历史只存在于本次编辑会话，保存与读取均使用同一份服务端配置。
const history = ref<string[]>([]);
const historyIndex = ref(0);
const canUndo = computed(() => historyIndex.value > 0);
const canRedo = computed(() => historyIndex.value < history.value.length - 1);
let restoring = false;
let historyTimer: ReturnType<typeof setTimeout> | undefined;
function checkpoint() {
  clearTimeout(historyTimer);
  if (restoring || loading.value) return;
  const snapshot = JSON.stringify(spec.value);
  if (snapshot === history.value[historyIndex.value]) return;
  history.value = history.value.slice(0, historyIndex.value + 1);
  history.value.push(snapshot);
  if (history.value.length > 80) history.value.shift();
  historyIndex.value = history.value.length - 1;
}
function resetHistory() {
  clearTimeout(historyTimer);
  history.value = [JSON.stringify(spec.value)];
  historyIndex.value = 0;
}
watch(
  spec,
  () => {
    if (restoring || loading.value) return;
    clearTimeout(historyTimer);
    historyTimer = setTimeout(checkpoint, 300);
  },
  { deep: true },
);
async function restore(index: number) {
  restoring = true;
  historyIndex.value = index;
  spec.value = JSON.parse(history.value[index]!);
  if (!spec.value.tasks.some((task) => task.id === selectedId.value))
    selectedId.value = "start";
  selectedEdgeId.value = "";
  await nextTick();
  restoring = false;
}
async function undo() {
  if (editingLocked.value) return;
  checkpoint();
  if (canUndo.value) await restore(historyIndex.value - 1);
}
async function redo() {
  if (editingLocked.value) return;
  clearTimeout(historyTimer);
  if (canRedo.value) await restore(historyIndex.value + 1);
}

async function ensurePage(
  task: Pick<ProcessTemplateTask, "pageId" | "pageVersion">,
) {
  if (!task.pageId || !task.pageVersion) return;
  const key = `${task.pageId}/${task.pageVersion}`;
  if (!versions.value[key]) {
    pendingPages.value++;
    try {
      versions.value[key] = await platformApi(
        `/pages/${task.pageId}?version=${task.pageVersion}`,
      );
    } finally {
      pendingPages.value--;
    }
  }
}
function taskFields(task: ProcessTemplateTask): FormField[] {
  const value = versions.value[`${task.pageId}/${task.pageVersion}`];
  return value
    ? composeFormSchema(value.model, value.page.schema).fields.filter(
        (field) => field.visible,
      )
    : [];
}
const pageChoices = computed(() =>
  pages.value.filter((item) => {
    if (!item.latestVersion || item.archivedAt) return false;
    return (
      !formLinked.value || item.definitionId === page.value?.draft.definitionId
    );
  }),
);
async function load() {
  busy.value = true;
  error.value = "";
  try {
    const [editor, availablePages, directory, templates] = await Promise.all([
      platformApi<PageEditorData>(`/pages/${pageId}/editor`),
      platformApi<PageSummary[]>(`/pages?applicationId=${appId}`),
      platformApi<ServerOrganization>("/organization"),
      platformApi<ProcessTemplateDraft[]>(
        `/process-templates?applicationId=${appId}`,
      ),
    ]);
    const templateId = String(route.query.templateId || "");
    const current = templateId
      ? templates.find((item) => item.id === templateId)
      : templates.find((item) => item.startPageId === pageId);
    if (templateId && !current)
      throw new Error("流程不存在或当前账号无权配置。");
    const history = current
      ? await platformApi<ProcessTemplateVersionSummary[]>(
          `/process-templates/${current.id}/versions`,
        )
      : [];
    if (current) {
      // 设计入口始终编辑现有草稿；已发布快照只在主动查看版本时读取。
      await displayVersion(current, 0);
    } else if (editor.draft.latestVersion) {
      const published = await platformApi<{
        page: PublishedPage;
        model: DataModel;
      }>(`/pages/${pageId}`);
      versions.value[`${pageId}/${published.page.version}`] = published;
      await displaySpec(
        {
          title: `${editor.draft.title}流程`,
          bindings: [
            {
              id: "main",
              title: editor.draft.title,
              definitionId: published.page.definitionId,
              definitionVersion: published.page.definitionVersion,
            },
          ],
          tasks: [],
        },
        0,
      );
    }
    page.value = editor;
    pages.value = availablePages;
    organization.value = directory;
    saved.value = current;
    versionHistory.value = history;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
    busy.value = false;
  }
}
async function reload() {
  if (operationBusy.value || !(await confirmLeave())) return;
  await load();
}
onMounted(load);

// 画布只展示用户保存的依赖与起止连线，不推断或补齐办理顺序。
const layoutPositions = computed(() => {
  const depths = new Map<string, number>();
  function depth(task: ProcessTemplateTask, path = new Set<string>()): number {
    if (path.has(task.id)) return 1;
    if (depths.has(task.id)) return depths.get(task.id)!;
    const ancestors = spec.value.tasks.filter((item) =>
      task.dependsOn.includes(item.id),
    );
    const next = new Set(path).add(task.id);
    const level = ancestors.length
      ? Math.max(...ancestors.map((item) => depth(item, next))) + 1
      : 1;
    depths.set(task.id, level);
    return level;
  }
  const groups = new Map<number, ProcessTemplateTask[]>();
  for (const task of spec.value.tasks) {
    const level = depth(task);
    groups.set(level, [...(groups.get(level) || []), task]);
  }
  const positions: Record<string, { x: number; y: number }> = {};
  groups.forEach((tasks, level) =>
    tasks.forEach((task, index) => {
      positions[task.id] = {
        x: (index - (tasks.length - 1) / 2) * 250,
        y: 56 + level * 155,
      };
    }),
  );
  return positions;
});
function assigneeLabel(task: ProcessTemplateTask) {
  if (task.assigneeSelector) {
    const values =
      task.assigneeSelector.kind === "department"
        ? organization.value?.spec.departments
        : organization.value?.spec.roles;
    return (
      values?.find((item) => item.id === task.assigneeSelector?.id)?.name ||
      "请选择处理范围"
    );
  }
  return (
    organization.value?.users.find((user) => user.id === task.assigneeId)
      ?.name || "请选择处理人"
  );
}
const nodes = computed<Node[]>(() => {
  const tasks = spec.value.tasks.map((task) => ({
    id: task.id,
    type: "workflow",
    position: task.position || layoutPositions.value[task.id]!,
    data: {
      label: task.title,
      kind: task.kind || "approval",
      owner: assigneeLabel(task),
    },
  }));
  const endY = tasks.length
    ? Math.max(...tasks.map((task) => task.position.y)) + 155
    : 250;
  return [
    {
      id: "start",
      type: "workflow",
      position: spec.value.layout?.start || { x: 0, y: 56 },
      data: { label: "流程发起节点", kind: "start" },
    },
    ...tasks,
    {
      id: "end",
      type: "workflow",
      position: spec.value.layout?.end || { x: 0, y: endY },
      data: { label: "流程结束节点", kind: "end" },
    },
  ];
});
function edge(source: string, target: string): Edge {
  const sourceNode = nodes.value.find((node) => node.id === source);
  const targetNode = nodes.value.find((node) => node.id === target);
  let sourceHandle = "bottom";
  if (
    source !== "start" &&
    sourceNode &&
    targetNode &&
    Math.abs(sourceNode.position.y - targetNode.position.y) < 80
  ) {
    sourceHandle =
      sourceNode.position.x < targetNode.position.x ? "right" : "left";
  }
  return {
    id: `${source}:${target}`,
    source,
    target,
    sourceHandle,
    targetHandle: "top",
    type: "smoothstep",
    style: {
      stroke:
        selectedEdgeId.value === `${source}:${target}` ? "#06b2a8" : "#3478ff",
      strokeWidth: 1.7,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#3478ff",
      width: 16,
      height: 16,
    },
    pathOptions: { borderRadius: 12, offset: 26 },
  };
}
const edges = computed<Edge[]>(() => {
  const connections: Edge[] = [];
  for (const target of spec.value.startTaskIds || []) {
    connections.push(edge("start", target));
  }
  for (const task of spec.value.tasks) {
    for (const source of task.dependsOn) {
      connections.push(edge(source, task.id));
    }
  }
  for (const source of spec.value.endTaskIds || []) {
    connections.push(edge(source, "end"));
  }
  return connections;
});
function select(id: string) {
  nodeMenu.value = undefined;
  selectedId.value = id;
  selectedEdgeId.value = "";
  panelTab.value = "node";
  showInspector.value = true;
}
function openNodeMenu({ node, event }: NodeMouseEvent) {
  event.preventDefault();
  if (editingLocked.value || !(event instanceof MouseEvent)) return;
  select(node.id);
  shortcutPosition.value = null;
  nodeMenu.value = {
    left: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)),
    top: Math.max(8, Math.min(event.clientY, window.innerHeight - 218)),
  };
}
function resetView() {
  // 画布先挂载保留布局，读取完成或切换版本后再按当前宽度定位。
  if (!canvas.value) return;
  setViewport(
    { x: canvas.value.clientWidth / 2 - 80, y: 0, zoom: 1 },
    { duration: 150 },
  );
}
function startNodeDrag(event: DragEvent, kind: "approval" | "copy") {
  if (
    editingLocked.value ||
    spec.value.tasks.length >= 30 ||
    !event.dataTransfer
  ) {
    event.preventDefault();
    return;
  }
  draggedKind.value = kind;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/x-workflow-node", kind);
}
function dragOverCanvas(event: DragEvent) {
  if (!draggedKind.value || editingLocked.value || !event.dataTransfer) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}
function dropNode(event: DragEvent) {
  const kind = draggedKind.value;
  draggedKind.value = undefined;
  if (!kind) return;
  event.preventDefault();
  const point = screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  // 按当前缩放和平移换算坐标，让节点中心落在松手位置。
  addTask(kind, { position: { x: point.x - 80, y: point.y - 20 } });
}
function addTask(
  kind: "approval" | "copy",
  {
    source,
    position,
  }: {
    source?: ProcessTemplateTask;
    position?: { x: number; y: number };
  } = {},
) {
  if (editingLocked.value || spec.value.tasks.length >= 30) return;
  checkpoint();
  const pageTask = spec.value.tasks.find((task) => task.pageId === pageId);
  const node =
    nodes.value.find((item) => item.id === selectedId.value) || nodes.value[0]!;
  const task: ProcessTemplateTask = source
    ? JSON.parse(JSON.stringify(source))
    : {
        id: "",
        title: kind === "copy" ? "抄送节点" : "流程节点",
        kind,
        assigneeId: "",
        recordBinding: spec.value.bindings[0]?.id || "",
        pageId,
        pageVersion:
          pageTask?.pageVersion || page.value?.draft.latestVersion || 0,
        dependsOn: [],
        requiredFields: [],
        fieldPermissions: {},
      };
  task.id = identity();
  if (source) task.title = `${source.title}（副本）`;
  task.position = position || {
    x: node.position.x + 40,
    y: node.position.y + 60,
  };
  // 新建和粘贴都只创建独立节点，连线必须由用户手动建立。
  task.dependsOn = [];
  for (const item of spec.value.tasks) {
    item.position ||= { ...layoutPositions.value[item.id]! };
  }
  spec.value.layout ||= {};
  spec.value.layout.end ||= {
    ...nodes.value.find((item) => item.id === "end")!.position,
  };
  spec.value.tasks.push(task);
  select(task.id);
  checkpoint();
  ensurePage(task).catch((cause) => {
    error.value = cause.message;
  });
}
function removeSelected() {
  if (editingLocked.value) return;
  nodeMenu.value = undefined;
  checkpoint();
  if (selectedEdgeId.value) {
    const connection = edges.value.find(
      (item) => item.id === selectedEdgeId.value,
    );
    if (!connection) return;
    if (connection.source === "start") {
      spec.value.startTaskIds = (spec.value.startTaskIds || []).filter(
        (id) => id !== connection.target,
      );
    } else if (connection.target === "end") {
      spec.value.endTaskIds = (spec.value.endTaskIds || []).filter(
        (id) => id !== connection.source,
      );
    } else {
      const task = spec.value.tasks.find(
        (item) => item.id === connection.target,
      )!;
      task.dependsOn = task.dependsOn.filter((id) => id !== connection.source);
    }
    selectedEdgeId.value = "";
  } else {
    const task = selected.value;
    if (!task) return;
    // 删除只移除相关连线，不替用户把前后节点重新接起来。
    for (const other of spec.value.tasks) {
      other.dependsOn = other.dependsOn.filter((id) => id !== task.id);
    }
    spec.value.startTaskIds = (spec.value.startTaskIds || []).filter(
      (id) => id !== task.id,
    );
    spec.value.endTaskIds = (spec.value.endTaskIds || []).filter(
      (id) => id !== task.id,
    );
    spec.value.tasks = spec.value.tasks.filter((item) => item.id !== task.id);
    select("start");
  }
  checkpoint();
}
function connect(connection: Connection) {
  if (editingLocked.value) return;
  const source = spec.value.tasks.find((task) => task.id === connection.source);
  const target = spec.value.tasks.find((task) => task.id === connection.target);
  if (connection.source === "start" && target) {
    checkpoint();
    spec.value.startTaskIds ||= [];
    if (!spec.value.startTaskIds.includes(target.id))
      spec.value.startTaskIds.push(target.id);
    error.value = "";
    checkpoint();
    return;
  }
  if (connection.target === "end" && source) {
    checkpoint();
    spec.value.endTaskIds ||= [];
    if (!spec.value.endTaskIds.includes(source.id))
      spec.value.endTaskIds.push(source.id);
    error.value = "";
    checkpoint();
    return;
  }
  if (!source || !target) {
    error.value = "请按发起节点、流程节点、结束节点的方向连接。";
    return;
  }
  const ancestors = new Set<string>();
  const visit = (id: string) => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    spec.value.tasks.find((task) => task.id === id)?.dependsOn.forEach(visit);
  };
  visit(connection.source);
  if (ancestors.has(target.id)) {
    error.value = "这条连线会形成循环，请连接到后续节点。";
    return;
  }
  checkpoint();
  if (!target.dependsOn.includes(connection.source))
    target.dependsOn.push(connection.source);
  error.value = "";
  checkpoint();
}
function positionNode({ node }: { node: Node }) {
  if (editingLocked.value) return;
  if (node.id === "start" || node.id === "end") {
    spec.value.layout ||= {};
    spec.value.layout[node.id] = { ...node.position };
  } else {
    const task = spec.value.tasks.find((item) => item.id === node.id);
    if (task) task.position = { ...node.position };
  }
  checkpoint();
}
async function arrange(horizontal = false) {
  if (editingLocked.value) return;
  checkpoint();
  spec.value.layout = undefined;
  for (const task of spec.value.tasks) {
    const position = layoutPositions.value[task.id]!;
    task.position = horizontal
      ? { x: ((position.y - 56) / 155) * 245, y: position.x }
      : { ...position };
  }
  if (horizontal)
    spec.value.layout = {
      start: { x: 0, y: 0 },
      end: {
        x:
          Math.max(0, ...spec.value.tasks.map((task) => task.position!.x)) +
          245,
        y: 0,
      },
    };
  checkpoint();
  await nextTick();
  fitView({ padding: 0.3, maxZoom: 1 });
}
const clipboard = ref<ProcessTemplateTask>();
function copyNode() {
  if (!selected.value) return;
  clipboard.value = JSON.parse(JSON.stringify(selected.value));
  nodeMenu.value = undefined;
}
function cutNode() {
  if (!selected.value || editingLocked.value) return;
  copyNode();
  removeSelected();
}
function pasteNode() {
  if (clipboard.value)
    addTask(clipboard.value.kind || "approval", { source: clipboard.value });
}
function toggleShortcuts(event: MouseEvent) {
  if (shortcutPosition.value) {
    shortcutPosition.value = null;
    return;
  }
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  shortcutPosition.value = {
    left: Math.max(16, Math.min(bounds.left - 160, window.innerWidth - 540)),
    top: bounds.bottom + 12,
  };
}
function releasePan() {
  spacePanning.value = false;
}
function keyboard(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (
    loading.value ||
    operationBusy.value ||
    document.querySelector("dialog[open]")
  )
    return;
  const modifier = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (modifier && key === "s") {
    event.preventDefault();
    save(false);
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable)
    return;
  if (event.code === "Space" && !modifier) {
    event.preventDefault();
    spacePanning.value = true;
    return;
  }
  if (key === "escape") {
    nodeMenu.value = undefined;
    shortcutPosition.value = null;
    selectedEdgeId.value = "";
    selectedId.value = "";
    releasePan();
    return;
  }
  if (key === "delete" || key === "backspace") {
    event.preventDefault();
    removeSelected();
    return;
  }
  if (!modifier) return;
  if (key === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  } else if (key === "y") {
    event.preventDefault();
    redo();
  } else if (key === "+" || key === "=") {
    event.preventDefault();
    zoomIn();
  } else if (key === "-") {
    event.preventDefault();
    zoomOut();
  } else if (key === "0") {
    event.preventDefault();
    fitView({ padding: 0.3, maxZoom: 1 });
  }
}
// 使用原生剪贴板事件，菜单复制和快捷键共用同一个节点副本。
function clipboardEvent(event: ClipboardEvent) {
  const target = event.target as HTMLElement;
  if (
    editingLocked.value ||
    loading.value ||
    document.querySelector("dialog[open]")
  )
    return;
  if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable)
    return;
  if (event.type === "copy" || event.type === "cut") {
    if (!selected.value || window.getSelection()?.toString()) return;
    event.clipboardData?.setData(
      "text/plain",
      `流程节点：${selected.value.title}`,
    );
    if (event.type === "cut") cutNode();
    else copyNode();
  } else {
    if (!clipboard.value) return;
    pasteNode();
  }
  event.preventDefault();
}
onMounted(() => {
  window.addEventListener("copy", clipboardEvent);
  window.addEventListener("cut", clipboardEvent);
  window.addEventListener("paste", clipboardEvent);
  window.addEventListener("keydown", keyboard);
  window.addEventListener("keyup", releasePan);
  window.addEventListener("blur", releasePan);
});
onBeforeUnmount(() => {
  clearTimeout(historyTimer);
  window.removeEventListener("copy", clipboardEvent);
  window.removeEventListener("cut", clipboardEvent);
  window.removeEventListener("paste", clipboardEvent);
  window.removeEventListener("keydown", keyboard);
  window.removeEventListener("keyup", releasePan);
  window.removeEventListener("blur", releasePan);
});
function removeUnusedBindings() {
  const used = new Set(
    spec.value.tasks.flatMap((task) => [
      task.recordBinding,
      task.waitFor?.recordBinding,
    ]),
  );
  spec.value.bindings = spec.value.bindings.filter((binding) =>
    used.has(binding.id),
  );
}
async function changePage(task: ProcessTemplateTask, targetPageId: string) {
  if (editingLocked.value) return;
  const target = pages.value.find((item) => item.id === targetPageId);
  if (!target) return;
  try {
    const pageVersion = target.latestVersion;
    await ensurePage({ pageId: target.id, pageVersion });
    if (!spec.value.tasks.includes(task)) return;
    const published = versions.value[`${target.id}/${pageVersion}`]!.page;
    let binding = spec.value.bindings.find(
      (item) =>
        item.definitionId === published.definitionId &&
        item.definitionVersion === published.definitionVersion,
    );
    if (!binding) {
      binding = {
        id: `data_${crypto.randomUUID().replaceAll("-", "")}`,
        title: published.title,
        definitionId: published.definitionId,
        definitionVersion: published.definitionVersion,
      };
      spec.value.bindings.push(binding);
    }
    // 页面版本与数据绑定一起替换，加载失败时保留原节点配置。
    Object.assign(task, {
      pageId: target.id,
      pageVersion,
      recordBinding: binding.id,
      subformId: undefined,
      requiredFields: [],
      fieldPermissions: {},
      waitFor: undefined,
    });
    removeUnusedBindings();
    checkpoint();
  } catch (cause) {
    error.value = (cause as Error).message;
  }
}
let requestId = crypto.randomUUID();
let requestFingerprint = "";
async function save(publish: boolean) {
  if (editingLocked.value) return;
  if (publish) {
    const connectionError = processTemplateConnectionError(spec.value);
    if (connectionError) {
      error.value = connectionError;
      return;
    }
  }
  busy.value = true;
  error.value = "";
  try {
    const fingerprint = JSON.stringify(spec.value);
    const submitted: ProcessTemplateSpec = JSON.parse(fingerprint);
    if (fingerprint !== requestFingerprint) {
      requestId = crypto.randomUUID();
      requestFingerprint = fingerprint;
    }
    saved.value = await platformApi<ProcessTemplateDraft>(
      saved.value
        ? `/process-templates/${saved.value.id}`
        : "/process-templates",
      saved.value ? "PUT" : "POST",
      {
        applicationId: appId,
        requestId,
        expectedRevision: saved.value?.revision,
        spec: submitted,
        ...(formLinked.value ? { startPageId: pageId } : {}),
      },
    );
    markSaved(submitted);
    if (publish) {
      await platformApi(
        `/process-templates/${saved.value.id}/publish`,
        "POST",
        { expectedRevision: saved.value.revision },
      );
      saved.value = (
        await platformApi<ProcessTemplateDraft[]>(
          `/process-templates?applicationId=${appId}`,
        )
      ).find((item) => item.id === saved.value?.id);
      await loadVersions();
    }
    notify(publish ? "已发布" : "已保存");
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function disable() {
  if (!saved.value || operationBusy.value) return;
  busy.value = true;
  error.value = "";
  try {
    saved.value = await platformApi(
      `/process-templates/${saved.value.id}/state`,
      "PUT",
      {
        expectedRevision: saved.value.revision,
        enabled: false,
      },
    );
    await loadVersions();
    notify("已停用");
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

async function loadVersions() {
  versionHistory.value = saved.value
    ? await platformApi<ProcessTemplateVersionSummary[]>(
        `/process-templates/${saved.value.id}/versions`,
      )
    : [];
}

/** 加载完整后再替换画布，失败时保留原内容和未保存状态。 */
async function displaySpec(content: ProcessTemplateSpec, version: number) {
  await Promise.all(content.tasks.map(ensurePage));
  spec.value = JSON.parse(JSON.stringify(content));
  selectedVersion.value = version;
  for (const task of spec.value.tasks) {
    task.position ||= { ...layoutPositions.value[task.id]! };
  }
  spec.value.layout ||= {};
  spec.value.layout.end ||= {
    ...nodes.value.find((node) => node.id === "end")!.position,
  };
  selectedId.value = spec.value.tasks[0]?.id || "start";
  selectedEdgeId.value = "";
  nodeMenu.value = undefined;
  await nextTick();
  markSaved();
  resetHistory();
  resetView();
}

async function displayVersion(current: ProcessTemplateDraft, version: number) {
  const target = version
    ? await platformApi<PublishedProcessTemplate>(
        `/process-templates/${current.id}/versions/${version}`,
      )
    : current;
  await displaySpec(target.spec, version);
}

async function showVersion(version: number) {
  if (operationBusy.value || version === selectedVersion.value) return;
  if (!(await confirmLeave())) return;
  busy.value = true;
  error.value = "";
  try {
    const templates = await platformApi<ProcessTemplateDraft[]>(
      `/process-templates?applicationId=${appId}`,
    );
    const current = templates.find((item) => item.id === saved.value?.id);
    if (!current) throw new Error("流程不存在，请重新读取。");
    const history = await platformApi<ProcessTemplateVersionSummary[]>(
      `/process-templates/${current.id}/versions`,
    );
    await displayVersion(current, version);
    saved.value = current;
    versionHistory.value = history;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

function requestVersionDraft(version: number) {
  if (operationBusy.value || !version) return;
  // 仅覆盖实际修改时确认，空设计稿直接进入编辑。
  if (dirty.value || saved.value?.hasDraftChanges) {
    creatingVersion.value = version;
  } else {
    void createVersionDraft(version);
  }
}

async function createVersionDraft(version = creatingVersion.value) {
  if (!saved.value || !version || operationBusy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const source = await platformApi<PublishedProcessTemplate>(
      `/process-templates/${saved.value.id}/versions/${version}`,
    );
    await Promise.all(source.spec.tasks.map(ensurePage));
    const next = await platformApi<ProcessTemplateDraft>(
      `/process-templates/${saved.value.id}`,
      "PUT",
      {
        expectedRevision: saved.value.revision,
        spec: source.spec,
      },
    );
    saved.value = next;
    await displaySpec(next.spec, 0);
    creatingVersion.value = undefined;
    notify(`已创建 V${next.latestVersion + 1} 草稿`);
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

async function activateVersion(version: number) {
  if (!saved.value || operationBusy.value) return;
  busy.value = true;
  error.value = "";
  try {
    saved.value = await platformApi<ProcessTemplateDraft>(
      `/process-templates/${saved.value.id}/state`,
      "PUT",
      {
        expectedRevision: saved.value.revision,
        enabled: true,
        version,
      },
    );
    await loadVersions();
    notify(`已启用 V${version}`);
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

async function removeVersion(version: number) {
  if (!saved.value || operationBusy.value) return;
  busy.value = true;
  error.value = "";
  try {
    saved.value = await platformApi<ProcessTemplateDraft>(
      `/process-templates/${saved.value.id}/versions/${version}`,
      "DELETE",
      {
        expectedRevision: saved.value.revision,
      },
    );
    await loadVersions();
    if (selectedVersion.value === version) {
      await displayVersion(saved.value, 0);
    }
    notify(`已删除 V${version}`);
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    class="application workflow-designer"
    @click="
      nodeMenu = undefined;
      shortcutPosition = null;
    "
  >
    <DesignerHeader
      :title="pageTitle"
      :app-id="appId"
      :form-id="pageId"
      active="flow"
      readonly-title
      @help="helpOpen = true"
    />
    <main class="designer-shell" :aria-busy="loading || operationBusy">
      <div v-if="error && page" class="flow-message error" role="alert">
        {{ error
        }}<button class="text-button" :disabled="operationBusy" @click="reload">
          重新读取
        </button>
      </div>
      <div
        v-if="confirmDiscard"
        class="flow-message config-discard"
        tabindex="-1"
      >
        流程尚未保存。<button class="button" @click="confirmDiscard = false">
          继续编辑</button
        ><button class="button" @click="discard">放弃修改并继续</button>
      </div>
      <div v-if="!loading && page && !ready" class="flow-empty">
        <h2>先发布表单，再设置流程</h2>
        <p>流程使用已发布的字段和权限。</p>
        <button
          class="button primary"
          @click="router.push(`/applications/${appId}/pages/${pageId}/publish`)"
        >
          去发布表单
        </button>
      </div>
      <template v-if="loading || !page || ready">
        <div
          class="toolbar"
          role="toolbar"
          aria-label="流程设计工具"
          :inert="loading || !ready || undefined"
        >
          <div class="toolbar-tools" :inert="editingLocked || undefined">
            <div class="tool-group history-tools">
              <button
                class="icon-button"
                :title="`撤销（${modifierKey} Z）`"
                aria-label="撤销"
                :disabled="!canUndo"
                @click="undo"
              >
                <AppIcon name="undo" :size="15" />
              </button>
              <button
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
              v-for="kind in nodeKinds"
              :key="kind.id"
              class="node-tool"
              :title="`拖拽${kind.label}到画布`"
              :disabled="spec.tasks.length >= 30"
              :draggable="spec.tasks.length < 30"
              @dragstart="startNodeDrag($event, kind.id)"
              @dragend="draggedKind = undefined"
            >
              <AppIcon :name="kind.id" :class="kind.id" :size="16" /><span>{{
                kind.label
              }}</span>
            </button>
            <button
              class="node-tool"
              disabled
              title="子流程尚未接入执行，暂不可添加"
            >
              <AppIcon name="subflow" class="subflow" :size="16" /><span
                >子流程</span
              >
            </button>
            <button
              class="node-tool"
              disabled
              title="插件节点尚未接入执行，暂不可添加"
            >
              <AppIcon name="plugin" class="plugin" :size="16" /><span
                >插件节点</span
              >
            </button>
            <span class="toolbar-divider" />
            <button
              class="icon-button"
              aria-label="自动整理"
              title="自动整理"
              @click="arrange()"
            >
              <AppIcon name="align" />
            </button>
            <button
              class="icon-button"
              aria-label="水平排列"
              title="水平排列"
              @click="arrange(true)"
            >
              <AppIcon name="horizontal" />
            </button>
            <span class="toolbar-divider" />
            <button
              class="icon-button"
              aria-label="删除所选节点或连线"
              title="删除所选节点或连线（Delete）"
              :disabled="!selected && !selectedEdgeId"
              @click="removeSelected"
            >
              <AppIcon name="trash" />
            </button>
            <button
              class="icon-button keyboard-tool"
              title="快捷键"
              aria-label="快捷键"
              :class="{ 'is-open': shortcutPosition }"
              :aria-expanded="!!shortcutPosition"
              @click.stop="toggleShortcuts"
            >
              <AppIcon name="keyboard" />
            </button>
          </div>
          <div class="toolbar-actions">
            <WorkflowVersions
              :versions="versionHistory"
              :draft-version="(saved?.latestVersion || 0) + 1"
              :selected-version="selectedVersion"
              :busy="operationBusy"
              :dirty="dirty"
              @select="showVersion"
              @create="requestVersionDraft"
              @activate="activateVersion"
              @remove="removeVersion"
            />
            <button class="button outline" @click="previewOpen = true">
              预览
            </button>
            <button
              v-if="selectedVersion"
              class="button primary"
              :disabled="operationBusy"
              @click="requestVersionDraft(selectedVersion)"
            >
              编辑此版本
            </button>
            <button
              v-if="!selectedVersion"
              class="button outline"
              :disabled="operationBusy"
              @click="save(false)"
            >
              保存
            </button>
            <button
              v-if="!selectedVersion"
              class="button primary activate-button"
              :disabled="operationBusy"
              @click="save(true)"
            >
              {{
                saved?.latestVersion && saved.enabled ? "发布更新" : "启用流程"
              }}
            </button>
          </div>
        </div>
        <div
          class="designer-body"
          :inert="loading || !ready || operationBusy || undefined"
        >
          <section
            ref="canvas"
            class="canvas-area"
            :class="{
              'is-panning': spacePanning,
              'is-dragging-node': draggedKind,
            }"
            aria-label="流程画布"
          >
            <VueFlow
              id="designer"
              :nodes="ready ? nodes : []"
              :edges="ready ? edges : []"
              :min-zoom="0.25"
              :max-zoom="2"
              :delete-key-code="null"
              pan-activation-key-code="Space"
              :nodes-draggable="!spacePanning && !editingLocked"
              :nodes-connectable="!spacePanning && !editingLocked"
              :connection-radius="28"
              :zoom-on-double-click="false"
              @dragenter="dragOverCanvas"
              @dragover="dragOverCanvas"
              @drop="dropNode"
              @init="resetView"
              @node-click="select($event.node.id)"
              @node-context-menu="openNodeMenu"
              @edge-click="selectedEdgeId = $event.edge.id"
              @node-drag-start="checkpoint"
              @node-drag-stop="positionNode"
              @connect="connect"
              @pane-click="selectedEdgeId = ''"
            >
              <Background :gap="24" :size="1.5" pattern-color="#dce1ec" />
              <template #node-workflow="props"
                ><WorkflowNode
                  v-bind="props"
                  :selected="selectedId === props.id && !selectedEdgeId"
                  :readonly="editingLocked"
              /></template>
              <MiniMap v-if="showMinimap" pannable zoomable />
            </VueFlow>
            <div v-if="draggedKind" class="canvas-drop-hint">
              拖到画布，松手添加节点
            </div>
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
                v-for="node in nodes"
                :key="node.id"
                :class="{ active: selectedId === node.id }"
                @click="
                  select(node.id);
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
            :readonly="editingLocked"
            v-model:tab="panelTab"
            :task="selected"
            :selected-id="selectedId"
            :spec="spec"
            :saved="saved"
            :fields="selected ? taskFields(selected) : []"
            :pages="pageChoices"
            :task-page-title="
              selected
                ? versions[`${selected.pageId}/${selected.pageVersion}`]?.page
                    .title
                : undefined
            "
            :organization="organization"
            :form-linked="formLinked"
            @page="changePage"
            @disable="disable"
          />
        </div>
      </template>
      <div v-if="loading || !page || pendingPages" class="flow-loading-status">
        <p v-if="loading || operationBusy" role="status">
          {{ page ? "正在读取办理表单…" : "正在读取流程…" }}
        </p>
        <p v-else-if="error" role="alert" class="field-error">
          {{ error }} <button class="button" @click="reload">重试</button>
        </p>
      </div>
    </main>
    <div
      v-if="nodeMenu"
      class="workflow-node-menu"
      role="menu"
      aria-label="节点操作"
      :style="{ left: `${nodeMenu.left}px`, top: `${nodeMenu.top}px` }"
      @contextmenu.prevent
    >
      <button role="menuitem" @click="select(selectedId)">节点属性</button>
      <button role="menuitem" :disabled="!selected" @click="copyNode">
        <span>复制节点</span><kbd>{{ modifierKey }} C</kbd>
      </button>
      <button role="menuitem" :disabled="!selected" @click="cutNode">
        <span>剪切节点</span><kbd>{{ modifierKey }} X</kbd>
      </button>
      <button
        role="menuitem"
        :disabled="!clipboard || spec.tasks.length >= 30"
        @click="pasteNode"
      >
        <span>粘贴节点</span><kbd>{{ modifierKey }} V</kbd>
      </button>
      <button
        role="menuitem"
        class="delete-node"
        :disabled="!selected"
        :title="selected ? '删除节点及其连线' : '流程起止节点不能删除'"
        @click="removeSelected"
      >
        <span>删除节点</span><kbd>Delete</kbd>
      </button>
    </div>
    <ShortcutPopover
      v-if="shortcutPosition"
      v-bind="shortcutPosition"
      :modifier="modifierKey"
    />
    <BaseDialog
      :open="creatingVersion !== undefined"
      :busy="busy"
      title="基于历史版本新建"
      @close="creatingVersion = undefined"
    >
      <p>
        将 V{{ creatingVersion }} 复制为 V{{ (saved?.latestVersion || 0) + 1 }}
        草稿，替换当前设计中的内容。
      </p>
      <p>当前启用版本和已发起的流程保持不变。</p>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <template #footer>
        <button
          class="button"
          :disabled="busy"
          @click="creatingVersion = undefined"
        >
          取消
        </button>
        <button
          class="button primary"
          :disabled="busy"
          @click="createVersionDraft()"
        >
          创建草稿
        </button>
      </template>
    </BaseDialog>
    <BaseDialog
      :open="previewOpen"
      title="流程预览"
      width="920px"
      @close="previewOpen = false"
    >
      <div class="preview-canvas">
        <VueFlow
          v-if="previewOpen"
          id="workflow-preview"
          :nodes="nodes"
          :edges="edges"
          :nodes-draggable="false"
          :nodes-connectable="false"
          :elements-selectable="false"
          :delete-key-code="null"
          fit-view-on-init
          :max-zoom="1"
          ><Background :gap="24" :size="1.5" pattern-color="#dce1ec" /><template
            #node-workflow="props"
            ><WorkflowNode v-bind="props" readonly /></template
        ></VueFlow>
      </div>
      <template #footer
        ><button class="button primary" @click="previewOpen = false">
          关闭
        </button></template
      >
    </BaseDialog>
    <BaseDialog :open="helpOpen" title="流程设计说明" @close="helpOpen = false"
      ><p>
        将工具栏节点拖到画布，松手添加。拖动节点调整位置，拖动连接点设置流转顺序。节点负责人、字段权限与流转条件在右侧设置。
      </p>
      <p>
        未连通的流程可以保存草稿；所有节点接通发起与结束节点后才能启用。启用后成员提交表单将进入流程。旧版本的待办继续按原版本办理。
      </p>
      <p>
        当前可执行办理、抄送、并行等待与逐行办理；子流程、插件、退回与加签尚未接入执行。
      </p>
      <template #footer
        ><button class="button primary" @click="helpOpen = false">
          知道了
        </button></template
      ></BaseDialog
    >
  </div>
</template>
<style scoped>
.designer-shell {
  position: relative;
}
.flow-loading-status {
  position: absolute;
  inset: 49px 0 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--muted);
  pointer-events: none;
}
.flow-loading-status > p {
  padding: 12px 16px;
  border-radius: 5px;
  background: var(--canvas);
}
.flow-loading-status button {
  pointer-events: auto;
}
</style>
