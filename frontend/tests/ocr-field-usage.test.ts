// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { ocrTemplate } from "@platform/contracts";
import {
  copy,
  createField,
  defaultValues,
  emptySchema,
  prepareSubmission,
  validateValues,
} from "../src/domain/form";
import {
  frontendValueFields,
  coerceFrontendValue,
  mapFrontendValues,
} from "../src/domain/frontendEventValues";
import {
  linkTypesMatch,
  selectionFilterOperators,
} from "../src/domain/fieldConfig";
import {
  applyFieldChange,
  defaultLinkLocalFields,
  defaultLinkSourceFields,
  linkedDefault,
  matchesFilters,
  relationCandidates,
  resolveChoices,
  sourceFields,
} from "../src/domain/relations";
import {
  newFrontendSelection,
  selectionCandidates,
  selectionFilterFields,
  selectionIssues,
  selectionSourceFields,
  selectionSourceValue,
} from "../src/domain/frontendSelections";
import {
  buildRecordBlocks,
  defaultDetailSettings,
  presentationFields,
  printFieldChoices,
} from "../src/domain/presentation";
import { buttonSources } from "../src/domain/buttons";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import { reminderFields } from "../src/domain/reminders";
import { configurableFields, compatibleField } from "../src/domain/extensions";
import {
  newForm,
  seedWorkspace,
  type FormEntry,
} from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import DataFilterEditor from "../src/features/forms/components/DataFilterEditor.vue";

let app: ReturnType<typeof createApp> | undefined;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});
function fixture() {
  const data = seedWorkspace(),
    form = newForm("oa", "SYN-识别来源", "form");
  const scan = createField("ocr", { id: "scan", label: "识别入口" });
  const legacy = createField("ocr", { id: "legacy", label: "原识别文本" });
  delete legacy.ocr;
  const output = createField("textarea", { id: "output", label: "识别内容" });
  scan.ocr = {
    type: "general",
    mappings: [
      {
        contentId: ocrTemplate("general")!.contents.find(
          (c) => c.label === "识别内容",
        )!.id,
        fieldId: output.id,
      },
    ],
  };
  const tabs = createField("tabs", {
    id: "tabs",
    children: [scan, legacy, output],
  });
  form.schema.fields = [
    tabs,
    createField("button", { id: "button" }),
    createField("divider", { id: "divider" }),
  ];
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-11T00:00:00Z",
  };
  form.versions = [copy(form.published)];
  data.forms.push(form);
  const entry: FormEntry = {
    id: "SYN-entry",
    formId: form.id,
    definitionVersion: 1,
    values: {
      scan: "SYN-injected-action",
      legacy: "旧文本",
      output: "识别结果",
    },
    status: "submitted",
    createdAt: "2026-10-11T00:00:00Z",
    history: [],
  };
  data.entries.push(entry);
  return { data, form, scan, legacy, output, entry };
}
const ids = (fields: { id: string }[]) => fields.map((f) => f.id);

it("excludes configured OCR from shared value scopes while retaining legacy text and action controls for permissions", () => {
  const { data, form } = fixture();
  for (const fields of [
    frontendValueFields(form.schema),
    defaultLinkLocalFields(form.schema.fields, "none"),
    sourceFields(data, form.id),
    defaultLinkSourceFields(data, form.id),
    selectionSourceFields(data, form.id, "lookup"),
  ])
    expect(ids(fields)).toEqual(["legacy", "output"]);
  expect(ids(frontendValueFields(form.schema, true))).toEqual([
    "scan",
    "legacy",
    "output",
    "button",
  ]);
});
it("rejects action values before coercion or a forced event return, atomically preserving normal outputs", () => {
  const { data, form, scan, legacy } = fixture(),
    values = { output: "原内容", legacy: "旧内容" };
  expect(() => coerceFrontendValue(scan, null, data, values)).toThrow();
  expect(() =>
    mapFrontendValues(
      form.schema,
      values,
      data,
      frontendValueFields(form.schema, true),
      [
        { fieldId: "output", value: "新内容" },
        { fieldId: "scan", value: "非法" },
      ],
      "merge",
    ),
  ).toThrow();
  expect(values).toEqual({ output: "原内容", legacy: "旧内容" });
  expect(coerceFrontendValue(legacy, "旧文本", data, values)).toBe("旧文本");
});
it("cannot filter or type-match an action even when the caller supplies it directly", () => {
  const { data, scan, legacy, entry } = fixture();
  expect(selectionFilterOperators(scan)).toEqual([]);
  expect(selectionFilterOperators(legacy)).toContain("contains");
  expect(linkTypesMatch(scan, scan)).toBe(false);
  expect(linkTypesMatch(legacy, legacy)).toBe(true);
  for (const operator of ["notEmpty", "equals"] as const)
    expect(
      matchesFilters(
        [
          {
            id: "filter",
            sourceFieldId: "scan",
            operator,
            source: "constant",
            value: "SYN-injected-action",
          },
        ],
        entry.values,
        {},
        data,
        "all",
        [scan],
      ),
    ).toBe(false);
});
it("keeps action IDs in old selection configuration but rejects display, temporary filters, sources and receivers", () => {
  const { data, form, scan, entry } = fixture();
  const fields = frontendValueFields(form.schema, true),
    selection = newFrontendSelection();
  selection.formId = form.id;
  selection.columns = ["scan"];
  const before = copy(selection);
  expect(selectionCandidates(selection, data, {}, [], "", "lookup")).toEqual(
    [],
  );
  expect(selectionFilterFields(selection, fields)).toEqual([]);
  expect(
    selectionIssues(selection, fields, fields, data, "lookup").some(
      (i) => i.target === "selection-columns",
    ),
  ).toBe(true);
  expect(() =>
    selectionSourceValue(
      entry,
      { ...scan, parentId: "", pathLabel: scan.label },
      data,
    ),
  ).toThrow();
  expect(selection).toEqual(before);
  selection.columns = ["output"];
  selection.mappings = [{ sourceFieldId: "legacy", targetFieldId: "scan" }];
  expect(
    selectionIssues(selection, fields, fields, data, "lookup").some(
      (i) => i.target === "selection-mappings",
    ),
  ).toBe(true);
});
it("prevents dynamic options and relations from consuming an injected action value", () => {
  const { data, form } = fixture();
  const choice = createField("select");
  choice.choiceSource = {
    ...choice.choiceSource,
    mode: "form",
    formId: form.id,
    labelFieldId: "scan",
  };
  expect(resolveChoices(choice, data, {})).toEqual([]);
  const relation = createField("relation", {
    referenceFormId: form.id,
    referenceFieldId: "output",
  });
  relation.reference.filters = [
    {
      id: "filter",
      sourceFieldId: "scan",
      source: "constant",
      operator: "notEmpty",
      value: "",
    },
  ];
  expect(relationCandidates(relation, data, {})).toEqual([]);
  choice.choiceSource.labelFieldId = "legacy";
  expect(resolveChoices(choice, data, {})).toEqual([
    { id: "SYN-entry", label: "旧文本" },
  ]);
});
it("skips relation mappings to or from actions while still filling ordinary and legacy fields", () => {
  const { data, form, scan, legacy, output, entry } = fixture();
  const relation = createField("relation", {
    id: "relation",
    referenceFormId: form.id,
    referenceFieldId: "output",
  });
  relation.reference.mappings = [
    { sourceFieldId: "scan", targetFieldId: "legacy" },
    { sourceFieldId: "output", targetFieldId: "scan" },
    { sourceFieldId: "output", targetFieldId: "output" },
  ];
  const original = { legacy: "保留旧内容", output: "原内容" };
  const result = applyFieldChange(
    [scan, legacy, output, relation],
    original,
    relation.id,
    entry.id,
    data,
  );
  expect(result).not.toHaveProperty("scan");
  expect(result.legacy).toBe("保留旧内容");
  expect(result.output).toBe("识别结果");
  expect(original).toEqual({ legacy: "保留旧内容", output: "原内容" });
});
it("default linkage cannot test an action payload but still accepts a legacy-text condition", () => {
  const { data, form } = fixture();
  const target = createField("textarea", { id: "target" });
  target.defaultLink = {
    enabled: true,
    formId: form.id,
    fieldId: "output",
    match: "all",
    filters: [
      {
        id: "filter",
        sourceFieldId: "scan",
        source: "constant",
        operator: "notEmpty",
        value: "",
      },
    ],
  };
  expect(linkedDefault(target, data, {})).toBe("");
  target.defaultLink.filters[0]!.sourceFieldId = "legacy";
  expect(linkedDefault(target, data, {})).toBe("识别结果");
});
it("does not generate, validate or persist action values and still traverses tabs", () => {
  const { form, scan, entry } = fixture();
  scan.required = true;
  expect(defaultValues(form.schema.fields)).not.toHaveProperty("scan");
  expect(
    validateValues(form.schema, { legacy: "旧文本", output: "识别结果" }),
  ).toEqual([]);
  expect(prepareSubmission(form.schema, entry.values)).toEqual({
    legacy: "旧文本",
    output: "识别结果",
  });
  expect(entry.values.scan).toBe("SYN-injected-action");
});
it("rejects saved relation mappings to an action at publication without rewriting them", () => {
  const { data, form, scan } = fixture();
  const relation = createField("relation", {
    id: "relation",
    referenceFormId: form.id,
    referenceFieldId: "output",
  });
  relation.reference.mappings = [
    { sourceFieldId: "output", targetFieldId: scan.id },
  ];
  const schema = {
      ...emptySchema(),
      fields: [copy(scan), createField("textarea", { id: "output" }), relation],
    },
    before = copy(schema);
  expect(validateFieldConfiguration(schema, data)).toContain(
    `「${relation.label}」字段映射不完整或引用已失效`,
  );
  expect(schema).toEqual(before);
});
it("shares value-only columns across record presentation, print, button inputs and reminders", () => {
  const { data, form, entry } = fixture();
  for (const fields of [
    presentationFields(form.schema),
    printFieldChoices(form.schema),
    buttonSources(form.schema),
    reminderFields(form.schema),
    configurableFields(form.schema),
  ])
    expect(ids(fields)).toEqual(["legacy", "output"]);
  expect(
    buildRecordBlocks(
      form.schema,
      entry.values,
      defaultDetailSettings(),
      data,
    ).map((b) => [b.id, b.text]),
  ).toEqual([
    ["legacy", "旧文本"],
    ["output", "识别结果"],
  ]);
  expect(compatibleField(form.schema.fields[0]!.children[0]!, "text")).toBe(
    false,
  );
  expect(compatibleField(form.schema.fields[0]!.children[1]!, "text")).toBe(
    true,
  );
});
it("the common filter editor removes actions from both lists without clearing a saved invalid binding", async () => {
  const { scan, legacy, output } = fixture();
  const filters = [
      {
        id: "filter",
        sourceFieldId: "scan",
        source: "field" as const,
        operator: "equals" as const,
        value: "scan",
      },
    ],
    before = copy(filters);
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp(() =>
    h(DataFilterEditor, {
      modelValue: filters,
      sourceFields: [scan, legacy, output],
      localFields: [scan, legacy, output],
    }),
  );
  app.mount(host);
  await nextTick();
  for (const suffix of ["来源字段", "引用字段"]) {
    const select = document.querySelector<HTMLSelectElement>(
      `[aria-label="条件1${suffix}"]`,
    )!;
    expect(
      [...select.options].filter((o) => !o.disabled).map((o) => o.value),
    ).not.toContain("scan");
    expect(select.value).toBe("scan");
    expect(select.selectedOptions[0]!.disabled).toBe(true);
  }
  expect(filters).toEqual(before);
});
it("real store submission retains immutable V1 OCR text after V2 changes the same ID into an action", async () => {
  const store = useWorkspaceStore(),
    created = (await store.createForm("oa", "SYN-文字识别版本", "form"))!,
    form = store.openForm(created.id)!;
  const { legacy, output, scan } = fixture();
  legacy.id = scan.id;
  form.schema = { ...emptySchema(), fields: [legacy, output] };
  expect(await store.publishForm(form.id)).toBe(true);
  const old = (await store.submitEntry(form.id, {
    scan: "V1旧识别文本",
    output: "V1内容",
  }))!;
  expect(old).toBeTruthy();
  form.schema.fields[0] = scan;
  expect(await store.publishForm(form.id)).toBe(true);
  const current = (await store.submitEntry(form.id, {
    scan: "非法入口值",
    output: "V2内容",
  }))!;
  expect(current.values).toEqual({ output: "V2内容" });
  expect(store.data.entries.find((e) => e.id === old.id)!.values.scan).toBe(
    "V1旧识别文本",
  );
  expect(form.versions[0]!.schema.fields[0]!.ocr).toBeUndefined();
  expect(form.versions[1]!.schema.fields[0]!.ocr?.type).toBe("general");
});
