import { createHash } from "node:crypto";
import { dataFields, emptyOrganizationSpec, organizationSubjectMembers, type DataModel, type FormPageSchema, type PagePublishImpact, type ProcessTemplateSpec } from "@platform/contracts";
import type { Transaction } from "./database";

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const fingerprint = (value: unknown) => JSON.stringify(canonical(value));
const controls = (schema?: FormPageSchema) => schema?.controls.flatMap(control => [control, ...control.children]) || [];
const ownControl = ({ children: _children, ...control }: any) => control;

/** Names and version references only: this preview never reads or returns business values. */
export async function pagePublishImpact(tx: Transaction, definition: any, page: any, model: DataModel, schema: FormPageSchema): Promise<PagePublishImpact> {
  const previous = (await tx.query("SELECT title,schema,definition_version FROM page_versions WHERE page_id=$1 AND version=$2", [page.id, page.latest_version])).rows[0];
  const before = new Map(controls(previous?.schema).map(control => [control.binding!.fieldId, control]));
  const after = new Map(controls(schema).map(control => [control.binding!.fieldId, control]));
  const names = new Map(dataFields(model).map(item => [item.field.id, item.parentId ? `${model.fields.find(f => f.id === item.parentId)!.name} / ${item.field.name}` : item.field.name]));
  const name = (id: string, control: any) => names.get(id) || control.properties.label || id;
  const oldModel = (await tx.query("SELECT model FROM data_object_versions WHERE definition_id=$1 AND version=$2", [definition.id, page.definition_version])).rows[0]?.model as DataModel | undefined;
  const oldIds = new Set(dataFields(oldModel || { version: 1, fields: [] }).map(item => item.field.id));
  const references: PagePublishImpact["references"] = [];
  for (const row of (await tx.query(`SELECT p.id,p.title,p.archived_at,p.definition_version,p.latest_version,p.draft,v.title AS public_title,v.schema,v.definition_version AS public_data_version
    FROM pages p LEFT JOIN page_versions v ON v.page_id=p.id AND v.version=p.latest_version
    WHERE p.definition_id=$1 AND p.id<>$2 ORDER BY p.id`, [definition.id, page.id])).rows) {
    if (row.latest_version) references.push({ kind: "page", id: row.id, title: row.public_title, state: "published", version: row.latest_version, detail: `${row.archived_at ? "已归档；" : ""}继续使用数据 V${row.public_data_version}；布局不变` });
    if (!row.latest_version || row.title !== row.public_title || row.definition_version !== row.public_data_version || fingerprint(row.draft) !== fingerprint(row.schema)) references.push({ kind: "page", id: row.id, title: row.title, state: "draft", version: row.latest_version, detail: `${row.archived_at ? "已归档；" : ""}草稿保持原样；采用新字段后自行选择放入页面` });
  }
  for (const row of (await tx.query(`SELECT d.id,d.draft,d.latest_version,v.spec FROM relation_definitions d LEFT JOIN relation_versions v ON v.relation_id=d.id AND v.version=d.latest_version
    WHERE d.source_definition_id=$1 OR d.target_definition_id=$1 ORDER BY d.id`, [definition.id])).rows) {
    if (row.spec) references.push({ kind: "relation", id: row.id, title: row.spec.title, state: "published", version: row.latest_version, detail: "关系、筛选和字段映射保持原配置；新增字段不会自动加入" });
    if (!row.spec || fingerprint(row.draft) !== fingerprint(row.spec)) references.push({ kind: "relation", id: row.id, title: row.draft.title, state: "draft", version: row.latest_version, detail: "关系草稿保持原样" });
  }
  for (const row of (await tx.query(`SELECT t.id,t.draft,t.latest_version,v.spec FROM process_templates t LEFT JOIN process_template_versions v ON v.template_id=t.id AND v.version=t.latest_version
    WHERE t.workspace_id=$1 ORDER BY t.id`, [definition.workspace_id])).rows) {
    const affected = (spec: ProcessTemplateSpec) => spec.bindings.some(binding => binding.definitionId === definition.id) || spec.tasks.some(task => task.pageId === page.id);
    const detail = (spec: ProcessTemplateSpec) => {
      const nodes = spec.tasks.filter(task => task.pageId === page.id);
      return nodes.length ? nodes.map(task => `${task.title}：继续使用本页 V${task.pageVersion}`).join("；") : "继续使用已绑定的数据和处理页面版本";
    };
    if (row.spec && affected(row.spec)) references.push({ kind: "process", id: row.id, title: row.spec.title, state: "published", version: row.latest_version, detail: detail(row.spec) });
    if ((!row.spec || fingerprint(row.draft) !== fingerprint(row.spec)) && affected(row.draft)) references.push({ kind: "process", id: row.id, title: row.draft.title, state: "draft", version: row.latest_version, detail: `${detail(row.draft)}；草稿不自动修改` });
  }
  const records = (await tx.query("SELECT definition_version AS version,count(*)::int AS count FROM records WHERE definition_id=$1 AND archived_at IS NULL GROUP BY definition_version ORDER BY definition_version", [definition.id])).rows;
  const tasks = (await tx.query(`SELECT (t.spec->>'pageVersion')::integer AS version,
    count(*) FILTER(WHERE t.status<>'completed')::int AS active,count(*) FILTER(WHERE t.status='completed')::int AS completed
    FROM tasks t JOIN processes p ON p.id=t.process_id WHERE p.workspace_id=$1 AND t.spec->>'pageId'=$2 GROUP BY t.spec->>'pageVersion' ORDER BY version`, [definition.workspace_id, page.id])).rows;
  const memberIds = new Set((await tx.query("SELECT user_id FROM grants WHERE definition_id=$1 AND policy->>'read'='true'", [definition.id])).rows.map(row => row.user_id));
  const organization = (await tx.query("SELECT spec FROM workspace_organizations WHERE workspace_id=$1", [definition.workspace_id])).rows[0]?.spec || emptyOrganizationSpec();
  for (const grant of (await tx.query("SELECT subject_kind,subject_id,include_children FROM subject_grants WHERE definition_id=$1 AND policy->>'read'='true'", [definition.id])).rows) {
    for (const id of organizationSubjectMembers(organization, { kind: grant.subject_kind, id: grant.subject_id, includeChildren: grant.include_children })) memberIds.add(id);
  }
  const authorizedMembers = (await tx.query("SELECT count(*)::int AS count FROM users WHERE workspace_id=$1 AND active AND role<>'admin' AND id=ANY($2::uuid[])", [definition.workspace_id, [...memberIds]])).rows[0].count;
  const impact: Omit<PagePublishImpact, "token"> = {
    pageId: page.id, title: page.title, revision: page.revision, fromVersion: page.latest_version, toVersion: page.latest_version + 1,
    definitionId: definition.id, definitionTitle: definition.title, definitionRevision: definition.revision,
    fromDataVersion: page.definition_version, toDataVersion: page.additions.length || page.definition_version === 0 ? definition.latest_version + 1 : page.definition_version,
    newFields: dataFields(model).filter(item => !oldIds.has(item.field.id)).map(item => ({ id: item.field.id, name: item.field.name, ...(item.parentId ? { parentName: model.fields.find(field => field.id === item.parentId)!.name } : {}) })),
    controls: {
      added: [...after].filter(([id]) => !before.has(id)).map(([id, control]) => name(id, control)),
      removed: [...before].filter(([id]) => !after.has(id)).map(([id, control]) => name(id, control)),
      changed: [...after].filter(([id, control]) => before.has(id) && fingerprint(ownControl(control)) !== fingerprint(ownControl(before.get(id)))).map(([id, control]) => name(id, control)),
      layoutChanged: !!previous && (fingerprint(previous.schema.settings) !== fingerprint(schema.settings) || fingerprint([...before.keys()].filter(id => after.has(id))) !== fingerprint([...after.keys()].filter(id => before.has(id)))),
      titleChanged: !!previous && previous.title !== page.title,
    }, references, records, tasks, authorizedMembers,
  };
  return { ...impact, token: createHash("sha256").update(fingerprint({ impact, model, schema })).digest("hex") };
}
