import { describe, expect, it } from "vitest";
import type { RecordDetail } from "@platform/contracts";
import { createField, emptySchema } from "../src/domain/form";
import { emptyServerRecord, recordChanges, recordRowChanges } from "../src/domain/serverRecords";
const quantity = createField("number", { id: "quantity" });
const hidden = createField("number", { id: "cost" });
const lines = createField("subform", {
  id: "lines",
  children: [quantity, hidden],
});
const detail: RecordDetail = {
  definition: {
    id: "form",
    title: "协作",
    version: 1,
    createdAt: "now",
    schema: { ...emptySchema(), fields: [lines] },
  },
  access: {
    userId: "user",
    read: true,
    edit: true,
    create: true,
    scope: "all",
    fields: { lines: "edit", quantity: "edit", cost: "read" },
  },
  record: {
    id: "record",
    definitionId: "form",
    definitionVersion: 1,
    revision: 5,
    createdBy: "user",
    createdAt: "now",
    updatedAt: "now",
    values: {
      lines: [
        { _rowId: "row-a", quantity: 1, cost: 9 },
        { _rowId: "row-b", quantity: 2, cost: 8 },
      ],
    },
    cellRevisions: { "lines/row-a/quantity": 2, "lines/row-b/quantity": 4 },
  },
};
describe("server record commands", () => {
  it("addresses reordered child rows by stable identity and uses the field's own revision", () => {
    const result = recordChanges(detail, {
      lines: [
        { _rowId: "row-b", quantity: 3, cost: 8 },
        { _rowId: "row-a", quantity: 1, cost: 9 },
      ],
    });
    expect(result).toEqual([
      {
        subformId: "lines",
        rowId: "row-b",
        fieldId: "quantity",
        value: 3,
        expectedRevision: 4,
      },
    ]);
  });
  it("does not submit readonly columns even if the client state was tampered with", () => {
    expect(
      recordChanges(detail, {
        lines: [
          { _rowId: "row-a", quantity: 1, cost: 999 },
          { _rowId: "row-b", quantity: 2, cost: 888 },
        ],
      }),
    ).toEqual([]);
  });
  it("a readonly parent prevents editing all its children", () => {
    const readonly = structuredClone(detail);
    readonly.access.fields.lines = "read";
    expect(
      recordChanges(readonly, {
        lines: [{ _rowId: "row-a", quantity: 4, cost: 9 }],
      }),
    ).toEqual([]);
    expect(emptyServerRecord(readonly)).toEqual({});
  });
  it("sends new rows without temporary IDs or readonly data and uses the original structure revision", () => {
    const value = structuredClone(detail); value.rowActions = { lines: { add: true, remove: false } }; value.record.rowRevisions = { lines: 7 };
    const edited = structuredClone(value.record.values); (edited.lines as any[]).push({ _rowId: "draft:new", quantity: 4, cost: 999 });
    expect(recordRowChanges(value, edited)).toEqual([{ action: "add", subformId: "lines", expectedRevision: 7, values: { quantity: 4 } }]);
    expect(recordChanges(value, edited)).toEqual([]);
  });
  it("removes by stable row ID with each cell's original revision, including readonly-page safeguards", () => {
    const value = structuredClone(detail); value.rowActions = { lines: { add: true, remove: true } };
    value.access.fields.cost = "edit"; value.record.cellRevisions["lines/row-a/cost"] = 6;
    const edited = structuredClone(value.record.values); (edited.lines as any[]).shift();
    expect(recordRowChanges(value, edited)).toEqual([{ action: "remove", subformId: "lines", rowId: "row-a", expectedRevision: 1, expectedCells: { "lines/row-a/quantity": 2, "lines/row-a/cost": 6 } }]);
    value.rowActions.lines!.remove = false;
    expect(() => recordRowChanges(value, edited)).toThrow("不能删除完整明细行");
  });
  it("rejects unknown persisted IDs and duplicate row identities", () => {
    const value = structuredClone(detail); value.rowActions = { lines: { add: true, remove: true } };
    const edited = structuredClone(value.record.values); (edited.lines as any[]).push({ _rowId: "forged", quantity: 4 });
    expect(() => recordRowChanges(value, edited)).toThrow("新增明细行身份不合法");
    (edited.lines as any[])[2]._rowId = "row-a";
    expect(() => recordRowChanges(value, edited)).toThrow("明细行身份重复");
  });
});
