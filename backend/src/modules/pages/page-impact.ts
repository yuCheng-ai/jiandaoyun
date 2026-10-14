import { createHash } from "node:crypto";
import {
  dataFields,
  emptyOrganizationSpec,
  organizationSubjectMembers,
  type DataModel,
  type DataModelImpact,
  type FormPageSchema,
  type PagePublishImpact,
  type ProcessTemplateSpec,
} from "@platform/contracts";
import type { Transaction } from "../../core/database/database";

/** 递归将对象属性按字典序排列，用于生成稳定对比指纹 */
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

const fingerprint = (value: unknown) => JSON.stringify(canonical(value));
const controls = (schema?: FormPageSchema) =>
  schema?.controls.flatMap((control) => [control, ...control.children]) || [];
const ownControl = ({ children: _children, ...control }: any) => control;

/**
 * 评估页面发布的整体影响范围（仅返回配置与数量汇总，不读取或暴露具体业务记录值）：
 * - 对比控件增删改与布局变化；
 * - 扫描同数据对象下的其他页面、关联关系、流程模板引用情况；
 * - 统计关联记录数、任务数及受影响授权成员数，并生成确认令牌。
 */
export async function pagePublishImpact(
  tx: Transaction,
  definition: any,
  page: any,
  model: DataModel,
  schema: FormPageSchema,
  publishesModel = page.additions.length > 0 || page.definition_version === 0,
  fields?: DataModelImpact,
): Promise<PagePublishImpact> {
  const prevRes = await tx.query(
    "SELECT title, schema, definition_version FROM page_versions WHERE page_id = $1 AND version = $2",
    [page.id, page.latest_version],
  );
  const previous = prevRes.rows[0];

  const before = new Map(controls(previous?.schema).map((control) => [control.binding!.fieldId, control]));
  const after = new Map(controls(schema).map((control) => [control.binding!.fieldId, control]));
  const names = new Map(
    dataFields(model).map((item) => {
      const label = item.parentId
        ? `${model.fields.find((f) => f.id === item.parentId)!.name} / ${item.field.name}`
        : item.field.name;
      return [item.field.id, label];
    }),
  );
  const name = (id: string, control: any) => names.get(id) || control.properties.label || id;

  const oldModelRes = await tx.query(
    "SELECT model FROM data_object_versions WHERE definition_id = $1 AND version = $2",
    [definition.id, page.definition_version],
  );
  const oldModel = oldModelRes.rows[0]?.model as DataModel | undefined;
  const oldIds = new Set(dataFields(oldModel || { version: 1, fields: [] }).map((item) => item.field.id));

  const references: PagePublishImpact["references"] = [];

  // 1. 检查同数据对象下的其他页面
  const siblingPageSql = `
    SELECT
      p.id, p.title, p.archived_at, p.definition_version, p.latest_version, p.draft,
      v.title AS public_title, v.schema, v.definition_version AS public_data_version
    FROM pages p
    LEFT JOIN page_versions v ON v.page_id = p.id AND v.version = p.latest_version
    WHERE p.definition_id = $1 AND p.id <> $2
    ORDER BY p.id
  `;
  const { rows: siblingPages } = await tx.query(siblingPageSql, [definition.id, page.id]);
  for (const row of siblingPages) {
    if (row.latest_version) {
      references.push({
        kind: "page",
        id: row.id,
        title: row.public_title,
        state: "published",
        version: row.latest_version,
        detail: `${row.archived_at ? "已归档；" : ""}继续使用数据 V${row.public_data_version}；布局不变`,
      });
    }
    const hasDraftDiff =
      !row.latest_version ||
      row.title !== row.public_title ||
      row.definition_version !== row.public_data_version ||
      fingerprint(row.draft) !== fingerprint(row.schema);
    if (hasDraftDiff) {
      references.push({
        kind: "page",
        id: row.id,
        title: row.title,
        state: "draft",
        version: row.latest_version,
        detail: `${row.archived_at ? "已归档；" : ""}草稿保持原样；采用新字段后自行选择放入页面`,
      });
    }
  }

  // 2. 检查引用该数据对象的关联关系
  const relationSql = `
    SELECT d.id, d.draft, d.latest_version, v.spec
    FROM relation_definitions d
    LEFT JOIN relation_versions v ON v.relation_id = d.id AND v.version = d.latest_version
    WHERE d.source_definition_id = $1 OR d.target_definition_id = $1
    ORDER BY d.id
  `;
  const { rows: relations } = await tx.query(relationSql, [definition.id]);
  for (const row of relations) {
    if (row.spec) {
      references.push({
        kind: "relation",
        id: row.id,
        title: row.spec.title,
        state: "published",
        version: row.latest_version,
        detail: "关系、筛选和字段映射保持原配置；新增字段不会自动加入",
      });
    }
    if (!row.spec || fingerprint(row.draft) !== fingerprint(row.spec)) {
      references.push({
        kind: "relation",
        id: row.id,
        title: row.draft.title,
        state: "draft",
        version: row.latest_version,
        detail: "关系草稿保持原样",
      });
    }
  }

  // 3. 检查引用该数据对象或页面的流程模板
  const processSql = `
    SELECT t.id, t.draft, t.latest_version, t.active_version, v.spec
    FROM process_templates t
    LEFT JOIN process_template_versions v ON v.template_id = t.id AND v.version = t.active_version
    WHERE t.workspace_id = $1
    ORDER BY t.id
  `;
  const { rows: templates } = await tx.query(processSql, [definition.workspace_id]);
  for (const row of templates) {
    const affected = (spec: ProcessTemplateSpec) =>
      spec.bindings.some((binding) => binding.definitionId === definition.id) ||
      spec.tasks.some((task) => task.pageId === page.id);
    const detail = (spec: ProcessTemplateSpec) => {
      const nodes = spec.tasks.filter((task) => task.pageId === page.id);
      if (nodes.length) {
        return nodes.map((task) => `${task.title}：继续使用本页 V${task.pageVersion}`).join("；");
      }
      return "继续使用已绑定的数据和处理页面版本";
    };

    if (row.spec && affected(row.spec)) {
      references.push({
        kind: "process",
        id: row.id,
        title: row.spec.title,
        state: "published",
        version: row.active_version,
        detail: detail(row.spec),
      });
    }
    if ((!row.spec || fingerprint(row.draft) !== fingerprint(row.spec)) && affected(row.draft)) {
      references.push({
        kind: "process",
        id: row.id,
        title: row.draft.title,
        state: "draft",
        version: row.latest_version,
        detail: `${detail(row.draft)}；草稿不自动修改`,
      });
    }
  }

  // 4. 统计记录数、流程任务数及授权成员人数
  const recordSql = `
    SELECT definition_version AS version, count(*)::int AS count
    FROM records
    WHERE definition_id = $1 AND archived_at IS NULL
    GROUP BY definition_version
    ORDER BY definition_version
  `;
  const { rows: records } = await tx.query(recordSql, [definition.id]);

  const taskSql = `
    SELECT
      (t.spec->>'pageVersion')::integer AS version,
      count(*) FILTER (WHERE t.status <> 'completed')::int AS active,
      count(*) FILTER (WHERE t.status = 'completed')::int AS completed
    FROM tasks t
    JOIN processes p ON p.id = t.process_id
    WHERE p.workspace_id = $1 AND t.spec->>'pageId' = $2
    GROUP BY t.spec->>'pageVersion'
    ORDER BY version
  `;
  const { rows: tasks } = await tx.query(taskSql, [definition.workspace_id, page.id]);

  const orgRes = await tx.query(
    "SELECT spec FROM workspace_organizations WHERE workspace_id = $1",
    [definition.workspace_id],
  );
  const organization = orgRes.rows[0]?.spec || emptyOrganizationSpec();

  const groupRes = await tx.query(
    "SELECT config FROM record_permission_groups WHERE definition_id = $1",
    [definition.id],
  );
  const groups = groupRes.rows[0]?.config?.groups || [];
  const memberIds = new Set<string>();

  for (const group of groups) {
    if (!group.enabled || group.archived) continue;
    for (const subject of group.subjects || []) {
      if (subject.kind === "member") {
        memberIds.add(subject.id);
      } else {
        for (const id of organizationSubjectMembers(organization, {
          kind: subject.kind,
          id: subject.id,
          includeChildren: subject.includeChildren,
        })) {
          memberIds.add(id);
        }
      }
    }
  }

  const authMemberRes = await tx.query(
    "SELECT count(*)::int AS count FROM users WHERE workspace_id = $1 AND active AND role <> 'admin' AND id = ANY($2::uuid[])",
    [definition.workspace_id, [...memberIds]],
  );
  const authorizedMembers = authMemberRes.rows[0].count;

  // 5. 组装影响预览结果与确认 Token
  const newFields = dataFields(model)
    .filter((item) => !oldIds.has(item.field.id))
    .map((item) => ({
      id: item.field.id,
      name: item.field.name,
      ...(item.parentId
        ? { parentName: model.fields.find((field) => field.id === item.parentId)!.name }
        : {}),
    }));

  const beforeSharedKeys = [...before.keys()].filter((id) => after.has(id));
  const afterSharedKeys = [...after.keys()].filter((id) => before.has(id));
  const layoutChanged =
    !!previous &&
    (fingerprint(previous.schema.settings) !== fingerprint(schema.settings) ||
      fingerprint(beforeSharedKeys) !== fingerprint(afterSharedKeys));

  const impact: Omit<PagePublishImpact, "token"> = {
    pageId: page.id,
    title: page.title,
    revision: page.revision,
    fromVersion: page.latest_version,
    toVersion: page.latest_version + 1,
    definitionId: definition.id,
    definitionTitle: definition.title,
    definitionRevision: definition.revision,
    fromDataVersion: page.definition_version,
    toDataVersion: publishesModel ? definition.latest_version + 1 : page.definition_version,
    ...(fields
      ? {
          fieldChanges: {
            changed: fields.changes.changed.map((field) =>
              field.parentName ? `${field.parentName} / ${field.name}` : field.name,
            ),
            renamed: fields.changes.renamed.map((field) => `${field.beforeName} → ${field.name}`),
            removed: fields.changes.removed.map((field) =>
              field.parentName ? `${field.parentName} / ${field.name}` : field.name,
            ),
          },
        }
      : {}),
    newFields,
    controls: {
      added: [...after].filter(([id]) => !before.has(id)).map(([id, control]) => name(id, control)),
      removed: [...before].filter(([id]) => !after.has(id)).map(([id, control]) => name(id, control)),
      changed: [...after]
        .filter(
          ([id, control]) =>
            before.has(id) && fingerprint(ownControl(control)) !== fingerprint(ownControl(before.get(id))),
        )
        .map(([id, control]) => name(id, control)),
      layoutChanged,
      titleChanged: !!previous && previous.title !== page.title,
    },
    references,
    records,
    tasks,
    authorizedMembers,
  };

  const token = createHash("sha256")
    .update(fingerprint({ impact, model, schema, fieldImpact: fields?.token }))
    .digest("hex");

  return { ...impact, token };
}
