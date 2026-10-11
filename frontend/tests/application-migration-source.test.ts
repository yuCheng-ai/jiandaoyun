import { expect, it } from "vitest";
import { readApplicationMigrationSource } from "../src/repositories/applicationMigrationSource";
import { seedWorkspace } from "../src/domain/workspace";

it("does not use a demonstration workspace when saved data is missing or unreadable", () => {
  expect(() => readApplicationMigrationSource({ getItem: () => null })).toThrow(
    "还没有已保存",
  );
  expect(() =>
    readApplicationMigrationSource({ getItem: () => "invalid" }),
  ).toThrow();
});
it("refuses inventory when the compatibility reader would silently filter a malformed record", () => {
  const data = seedWorkspace();
  data.entries.push({
    id: "invalid_record",
    formId: data.forms[0].id,
    status: "unsupported",
  } as never);
  const raw = JSON.stringify(data);
  expect(() => readApplicationMigrationSource({ getItem: () => raw })).toThrow(
    "entries",
  );
});
it("refuses to omit unrecognized arrays of saved configuration", () => {
  const data = seedWorkspace();
  (data.forms[0].extensions as any).futureActions = [{ id: "original_action" }];
  expect(() =>
    readApplicationMigrationSource({ getItem: () => JSON.stringify(data) }),
  ).toThrow("futureActions");
});
it("reads a validated snapshot without modifying stored data or manufacturing target identities", () => {
  const data = seedWorkspace(),
    raw = JSON.stringify(data);
  const source = readApplicationMigrationSource({ getItem: () => raw });
  expect(source.stamp).toBe(raw);
  expect(source.data.forms.map((form) => form.id)).toEqual(
    data.forms.map((form) => form.id),
  );
  expect(source.data.entries).toEqual(data.entries);
  expect(raw).toBe(JSON.stringify(data));
});

it("does not block on stale recent-navigation cache entries", () => {
  const data = seedWorkspace();
  data.recentFormIds.push("removed_form");
  const source = readApplicationMigrationSource({
    getItem: () => JSON.stringify(data),
  });
  expect(source.data.forms).toHaveLength(data.forms.length);
  expect(source.data.entries).toEqual(data.entries);
  expect(source.stamp).toContain("removed_form");
});
