import { ref, computed, watch, nextTick, onBeforeUnmount, type Ref } from "vue";
import {
  initialDocument,
  serialize,
  parseDocument,
  makeNode,
  makeEdge,
  removeNode,
  connectionError,
  reaches,
  copyFragment,
  pasteFragment,
  type WorkflowFragment,
  type FlowDocument,
  type NodeKind,
  type NodeData,
} from "../domain/workflow";
import type { Connection } from "@vue-flow/core";

const STORAGE_KEY = "vue-workflow-designer-v1";
export function useWorkflow(options?: {
  initial: FlowDocument;
  onChange: (value: FlowDocument) => void;
  onSave: (
    value: FlowDocument,
  ) => boolean | undefined | Promise<boolean | undefined>;
}) {
  let saved: string | null = null,
    loadError = "";
  let initial = initialDocument();
  try {
    saved = options
      ? serialize(options.initial)
      : localStorage.getItem(STORAGE_KEY);
    if (saved) initial = parseDocument(saved);
  } catch {
    loadError = "本地流程读取失败，已打开新草稿；原存储数据未覆盖。";
  }
  const doc = ref(initial) as Ref<FlowDocument>;
  const selectedId = ref("1"),
    selectedEdgeId = ref<string | null>(null);
  const selected = computed(() =>
    doc.value.nodes.find((n) => n.id === selectedId.value),
  );
  const lastSaved = ref(saved ? serialize(initial) : ""),
    savedTime = ref("");
  const saving = ref(false);
  const history = ref([serialize(initial)]),
    cursor = ref(0);
  const dirty = computed(() => serialize(doc.value) !== lastSaved.value);
  const canUndo = computed(() => cursor.value > 0),
    canRedo = computed(() => cursor.value < history.value.length - 1);
  let historyTimer: ReturnType<typeof setTimeout> | undefined,
    restoring = false;
  function checkpoint() {
    clearTimeout(historyTimer);
    const snapshot = serialize(doc.value);
    if (snapshot === history.value[cursor.value]) return;
    history.value = history.value.slice(0, cursor.value + 1);
    history.value.push(snapshot);
    if (history.value.length > 80) history.value.shift();
    cursor.value = history.value.length - 1;
  }
  watch(
    () => serialize(doc.value),
    () => {
      if (restoring) return;
      options?.onChange(doc.value);
      clearTimeout(historyTimer);
      historyTimer = setTimeout(checkpoint, 300);
      if (
        !saving.value &&
        doc.value.enabled &&
        serialize(doc.value) !== lastSaved.value
      )
        doc.value.enabled = false;
    },
  );
  async function restore(index: number) {
    restoring = true;
    cursor.value = index;
    doc.value = parseDocument(history.value[index]!);
    options?.onChange(doc.value);
    if (!doc.value.nodes.some((n) => n.id === selectedId.value))
      selectedId.value = "start";
    await nextTick();
    restoring = false;
  }
  async function undo() {
    checkpoint();
    if (canUndo.value) await restore(cursor.value - 1);
  }
  async function redo() {
    clearTimeout(historyTimer);
    if (canRedo.value) await restore(cursor.value + 1);
  }
  let clipboard: WorkflowFragment | null = null;
  let pasteCount = 0;
  function copySelection(): string {
    const ids = selectedEdgeId.value
      ? []
      : doc.value.nodes
          .filter((n) => n.selected || n.id === selectedId.value)
          .map((n) => n.id);
    const fragment = copyFragment(doc.value, ids, selectedEdgeId.value);
    if (!fragment.nodes.length)
      return "请选择可复制的流程节点，开始和结束节点不可复制";
    clipboard = fragment;
    pasteCount = 0;
    return selectedEdgeId.value
      ? "已复制连线及相关节点"
      : `已复制 ${fragment.nodes.length} 个节点`;
  }
  function pasteSelection(): string | null {
    if (!clipboard?.nodes.length) return "请先在画布中复制节点或连线";
    checkpoint();
    const ids = pasteFragment(doc.value, clipboard, ++pasteCount * 44);
    doc.value.nodes.forEach((n) => (n.selected = ids.includes(n.id)));
    select(ids.at(-1) || "");
    checkpoint();
    return null;
  }
  function select(id: string) {
    selectedId.value = id;
    selectedEdgeId.value = null;
  }
  function updateNode(id: string, patch: Partial<NodeData>) {
    const node = doc.value.nodes.find((n) => n.id === id);
    if (node) node.data = { ...node.data, ...patch };
  }
  function nextId() {
    return String(
      Math.max(0, ...doc.value.nodes.map((n) => Number(n.id) || 0)) + 1,
    );
  }
  function add(
    kind: NodeKind,
    anchorId = selectedId.value,
    direction: "before" | "after" = "after",
  ) {
    checkpoint();
    let anchor =
      doc.value.nodes.find((n) => n.id === anchorId) ||
      doc.value.nodes.find((n) => n.data.kind === "start")!;
    if (anchor.data.kind === "end") direction = "before";
    if (anchor.data.kind === "start") direction = "after";
    const id = nextId(),
      node = makeNode(
        id,
        kind,
        anchor.position.x,
        anchor.position.y + (direction === "after" ? 132 : 0),
      );
    const connectedEdges = doc.value.edges.filter((e) =>
      direction === "after" ? e.source === anchor.id : e.target === anchor.id,
    );
    const oldEdges =
      direction === "after" && anchor.data.kind === "condition"
        ? connectedEdges.slice(0, 1)
        : connectedEdges;
    if (direction === "after") {
      const downstream = doc.value.nodes.filter(
        (n) => n.id !== anchor.id && reaches(anchor.id, n.id, doc.value.edges),
      );
      downstream.forEach(
        (n) => (n.position.y += kind === "condition" ? 280 : 132),
      );
      doc.value.edges = doc.value.edges.filter((e) => !oldEdges.includes(e));
      doc.value.edges.push(
        makeEdge(anchor.id, id, { label: oldEdges[0]?.label }),
      );
    } else {
      const downstream = doc.value.nodes.filter((n) =>
        reaches(anchor.id, n.id, doc.value.edges),
      );
      downstream.forEach(
        (n) => (n.position.y += kind === "condition" ? 280 : 132),
      );
      doc.value.edges = doc.value.edges.filter((e) => !oldEdges.includes(e));
      oldEdges.forEach((e) =>
        doc.value.edges.push(
          makeEdge(e.source, id, {
            sourceHandle: e.sourceHandle,
            label: e.label,
          }),
        ),
      );
    }
    doc.value.nodes.push(node);
    const successors =
      direction === "after" ? oldEdges.map((e) => e.target) : [anchor.id];
    if (kind === "condition") {
      const left = makeNode(
        nextId(),
        "approval",
        node.position.x - 150,
        node.position.y + 132,
      );
      doc.value.nodes.push(left);
      const right = makeNode(
        nextId(),
        "approval",
        node.position.x + 150,
        node.position.y + 132,
      );
      left.data.label = "条件审批";
      right.data.label = "默认审批";
      doc.value.nodes.push(right);
      doc.value.edges.push(
        makeEdge(id, left.id, { label: "满足条件" }),
        makeEdge(id, right.id, { label: "其他情况" }),
      );
      successors.forEach((target) =>
        doc.value.edges.push(
          makeEdge(left.id, target),
          makeEdge(right.id, target),
        ),
      );
    } else
      successors.forEach((target) =>
        doc.value.edges.push(makeEdge(id, target)),
      );
    select(id);
    checkpoint();
  }
  function removeSelected() {
    checkpoint();
    if (selectedEdgeId.value) {
      doc.value.edges = doc.value.edges.filter(
        (e) => e.id !== selectedEdgeId.value,
      );
      selectedEdgeId.value = null;
    } else if (
      selected.value &&
      !["start", "end"].includes(selected.value.data.kind)
    ) {
      removeNode(doc.value, selectedId.value);
      select("start");
    }
    checkpoint();
  }
  function connect(connection: Connection): string | null {
    const error = connectionError(
      connection.source,
      connection.target,
      doc.value,
    );
    if (error) return error;
    checkpoint();
    doc.value.edges.push(
      makeEdge(connection.source, connection.target, {
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      }),
    );
    checkpoint();
    return null;
  }
  async function save(): Promise<boolean> {
    if (saving.value) return false;
    saving.value = true;
    try {
      const snapshot = serialize(doc.value);
      if (options) {
        if (!(await options.onSave(doc.value))) return false;
      } else localStorage.setItem(STORAGE_KEY, snapshot);
      lastSaved.value = snapshot;
      savedTime.value = new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
      checkpoint();
      return true;
    } catch {
      return false;
    } finally {
      saving.value = false;
      if (doc.value.enabled && serialize(doc.value) !== lastSaved.value)
        doc.value.enabled = false;
    }
  }
  function replace(text: string) {
    const parsed = parseDocument(text);
    checkpoint();
    doc.value = parsed;
    selectedId.value = parsed.nodes[0]?.id || "";
    checkpoint();
  }
  function layout(horizontal = false) {
    checkpoint();
    const start = doc.value.nodes.find((n) => n.data.kind === "start");
    if (!start) return;
    const depth = new Map([[start.id, 0]]),
      queue = [start.id],
      visited = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      doc.value.edges
        .filter((e) => e.source === id)
        .forEach((e) => {
          depth.set(
            e.target,
            Math.max(depth.get(e.target) || 0, (depth.get(id) || 0) + 1),
          );
          queue.push(e.target);
        });
    }
    const groups = new Map<number, typeof doc.value.nodes>();
    doc.value.nodes.forEach((n) => {
      const d = depth.get(n.id) ?? depth.size;
      groups.set(d, [...(groups.get(d) || []), n]);
    });
    groups.forEach((nodes, level) =>
      nodes.forEach((n, i) => {
        n.position = horizontal
          ? { x: level * 245, y: 180 + (i - (nodes.length - 1) / 2) * 110 }
          : { x: (i - (nodes.length - 1) / 2) * 250, y: 56 + level * 155 };
      }),
    );
    checkpoint();
  }
  onBeforeUnmount(() => clearTimeout(historyTimer));
  return {
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
  };
}
