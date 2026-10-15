import { seedOrganization } from "./fixtures/workspace";

import { describe, it, expect } from "vitest";
import {
  initialDocument,
  makeNode,
  makeEdge,
  connectionError,
  validate,
  removeNode,
  parseDocument,
  serialize,
  simulationPath,
  copyFragment,
  pasteFragment,
} from "../src/domain/workflow";

describe("workflow graph", () => {
  it("requires an assignee, then accepts a complete approval path", () => {
    const doc = initialDocument();
    expect(validate(doc)).toEqual([
      { nodeId: "1", message: "请为「流程节点」选择节点负责人" },
    ]);
    doc.nodes[1]!.data.members = ["zhang"];
    expect(validate(doc)).toEqual([]);
  });
  it("rejects self connections, duplicate edges, cycles and terminal reversals", () => {
    const doc = initialDocument();
    expect(connectionError("1", "1", doc)).toContain("自身");
    expect(connectionError("start", "1", doc)).toContain("已经连接");
    expect(connectionError("end", "1", doc)).toContain("方向");
    expect(connectionError("1", "start", doc)).toContain("方向");
    doc.nodes.push(makeNode("2", "approval", 0, 300));
    doc.edges = [
      makeEdge("start", "1"),
      makeEdge("1", "2"),
      makeEdge("2", "end"),
    ];
    expect(connectionError("2", "1", doc)).toContain("循环");
  });
  it("reconnects a removed approval without dangling edges and protects terminals", () => {
    const doc = initialDocument();
    removeNode(doc, "1");
    expect(doc.nodes.map((n) => n.id)).toEqual(["start", "end"]);
    expect(doc.edges.map((e) => [e.source, e.target])).toEqual([
      ["start", "end"],
    ]);
    removeNode(doc, "start");
    removeNode(doc, "end");
    expect(doc.nodes).toHaveLength(2);
  });
  it("detects disconnected paths and cycles", () => {
    const doc = initialDocument();
    doc.nodes[1]!.data.members = ["zhang"];
    doc.edges = [makeEdge("start", "1")];
    expect(validate(doc).some((i) => i.message.includes("完整流程"))).toBe(
      true,
    );
    doc.nodes.push(makeNode("2", "copy", 0, 0));
    doc.edges.push(makeEdge("1", "2"), makeEdge("2", "1"));
    expect(validate(doc).some((i) => i.message.includes("循环"))).toBe(true);
  });
  it("selects the correct conditional branch with a shared merge", () => {
    const doc = initialDocument();
    const branch = makeNode("branch", "condition", 0, 100);
    const left = makeNode("left", "approval", -100, 200),
      right = makeNode("right", "approval", 100, 200);
    doc.nodes = [doc.nodes[0]!, branch, left, right, doc.nodes[2]!];
    doc.edges = [
      makeEdge("start", "branch"),
      makeEdge("branch", "left"),
      makeEdge("branch", "right"),
      makeEdge("left", "end"),
      makeEdge("right", "end"),
    ];
    expect(simulationPath(doc, 6000).map((n) => n.id)).toEqual([
      "start",
      "branch",
      "left",
      "end",
    ]);
    expect(simulationPath(doc, 5000).map((n) => n.id)).toEqual([
      "start",
      "branch",
      "right",
      "end",
    ]);
  });
  it("round trips configuration without transient canvas state", () => {
    const doc = initialDocument();
    doc.nodes[1]!.data.members = ["zhang", "finance"];
    doc.nodes[1]!.data.timeout = 24;
    doc.nodes[1]!.selected = true;
    const saved = serialize(doc),
      restored = parseDocument(saved);
    expect(restored.nodes[1]!.data.members).toEqual(["zhang", "finance"]);
    expect(restored.nodes[1]!.data.timeout).toBe(24);
    expect(restored.nodes[1]!.selected).toBeUndefined();
    expect(serialize(restored)).toEqual(saved);
  });
  it("ignores canvas-generated empty labels in history snapshots", () => {
    const doc = initialDocument(),
      before = serialize(doc);
    doc.edges.forEach((e) => (e.label = ""));
    expect(serialize(doc)).toBe(before);
  });
  it("rejects invalid imports and sanitizes missing optional properties", () => {
    expect(() => parseDocument("{}")).toThrow("有效的流程");
    const doc = initialDocument();
    doc.nodes[1]!.id = "start";
    expect(() => parseDocument(JSON.stringify(doc))).toThrow("重复");
    const bad = initialDocument();
    bad.edges[0]!.target = "missing";
    expect(() => parseDocument(JSON.stringify(bad))).toThrow("不存在");
    const partial = JSON.parse(serialize(initialDocument()));
    partial.nodes[1].data.members = "bad";
    partial.nodes[1].data.permissions = null;
    expect(
      parseDocument(JSON.stringify(partial)).nodes[1]!.data.members,
    ).toEqual([]);
  });
});

describe("workflow clipboard", () => {
  it("copies editable nodes independently without duplicating terminals", () => {
    const doc = initialDocument();
    doc.nodes[1]!.data.members = ["zhang"];
    const fragment = copyFragment(doc, ["start", "1", "end"]);
    expect(fragment.nodes.map((n) => n.id)).toEqual(["1"]);
    expect(fragment.edges).toEqual([]);
    const ids = pasteFragment(doc, fragment);
    expect(ids).toEqual(["2"]);
    const pasted = doc.nodes.find((n) => n.id === "2")!;
    expect(pasted.position).toEqual({ x: 44, y: 286 });
    pasted.data.members.push("li");
    expect(doc.nodes[1]!.data.members).toEqual(["zhang"]);
    expect(fragment.nodes[0]!.data.members).toEqual(["zhang"]);
    expect(doc.nodes.filter((n) => n.data.kind === "start")).toHaveLength(1);
  });
  it("copies a connection with its editable endpoints and remaps all IDs", () => {
    const doc = initialDocument();
    doc.nodes.push(makeNode("2", "copy", 0, 380));
    doc.edges = [
      makeEdge("start", "1"),
      makeEdge("1", "2", { label: "已同意" }),
      makeEdge("2", "end"),
    ];
    const fragment = copyFragment(doc, [], "e-1-2-bottom");
    expect(fragment.nodes.map((n) => n.id)).toEqual(["1", "2"]);
    expect(pasteFragment(doc, fragment)).toEqual(["3", "4"]);
    expect(
      doc.edges.find((e) => e.source === "3" && e.target === "4")?.label,
    ).toBe("已同意");
    expect(doc.edges.some((e) => e.source === "1" && e.target === "4")).toBe(
      false,
    );
    expect(pasteFragment(doc, fragment, 88)).toEqual(["5", "6"]);
    expect(new Set(doc.nodes.map((n) => n.id)).size).toBe(doc.nodes.length);
  });
  it("does not include edges to uncopied nodes", () => {
    const doc = initialDocument();
    expect(copyFragment(doc, ["start", "end"]).nodes).toEqual([]);
    const fragment = copyFragment(doc, [], "e-start-1-bottom");
    expect(fragment.nodes.map((n) => n.id)).toEqual(["1"]);
    expect(fragment.edges).toEqual([]);
  });
});

it("resolves role assignees and rejects roles without active members", () => {
  const doc = initialDocument(),
    org = seedOrganization();
  doc.nodes[1]!.data.members = ["role_finance"];
  expect(validate(doc, org)).toEqual([]);
  org.employees.find((e) => e.id === "zhao")!.status = "left";
  expect(validate(doc, org)[0]!.message).toContain("没有在职成员");
});
