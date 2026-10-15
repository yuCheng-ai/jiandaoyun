import { seedWorkspace, newAccessGroup } from "./fixtures/workspace";
import { expect, it } from "vitest";
import { copy, createField } from "../src/domain/form";
import { defaultAccess } from "../src/domain/access";

import { memberImportColumns } from "../src/domain/recordImport";

it("does not expose hidden/read-only container children after flattening tabs for a creation template", () => {
  const data = seedWorkspace();
  const form = data.forms[0]!;
  form.schema.fields = [
    createField("tabs", {
      id: "tab",
      visible: false,
      children: [createField("text", { id: "child" })],
    }),
    createField("subform", {
      id: "lines",
      editable: false,
      children: [
        createField("text", { id: "line" }),
        createField("number", { id: "qty" }),
      ],
    }),
  ];
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-10",
  };
  form.versions = [form.published];
  const group = newAccessGroup(form.schema, "self");
  group.identities = ["zhang"];
  group.actions = ["view", "import"];
  data.formAccess = {
    [form.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
  };
  expect(
    memberImportColumns(form, "create", data, {
      actorId: "zhang",
      selection: group.id,
    }),
  ).toEqual([]);
});
