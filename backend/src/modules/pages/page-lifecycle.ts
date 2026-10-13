import { ConflictException, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  dataModelChanges,
  type DataModel,
  type PageLifecycleImpact,
  type ProcessTemplateSpec,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import type { Database, Transaction } from "../../core/database/database";
import { pageBindings } from "./page-schema";

/** 递归将对象属性按字典序排列，用于生成稳定的哈希摘要 */
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

/**
 * 校验目标页面存在且处于未归档状态（调用方需持有所属数据定义的锁）
 */
export async function assertPageActive(tx: Pick<Database, "query">, actor: Actor, id: string) {
  const { rows } = await tx.query(
    "SELECT archived_at, title FROM pages WHERE id = $1 AND workspace_id = $2",
    [id, actor.workspaceId],
  );
  const page = rows[0];
  if (!page) {
    throw new NotFoundException("页面不存在或不可访问");
  }
  if (page.archived_at) {
    throw new ConflictException(`「${page.title}」已归档，请选择其他页面或由管理员恢复；已发任务可从待办继续处理`);
  }
}

/**
 * 评估页面归档或恢复操作对流程模板、待办任务及数据模型版本的影响，并生成防篡改确认令牌
 */
export async function pageLifecycleImpact(
  tx: Transaction,
  definition: any,
  page: any,
  action: "archive" | "restore",
): Promise<PageLifecycleImpact> {
  const references: PageLifecycleImpact["references"] = [];
  const stamps: unknown[] = [];

  const addReference = (
    id: string,
    spec: ProcessTemplateSpec,
    state: "draft" | "published",
    version: number,
    revision: number,
  ) => {
    const tasks = spec.tasks
      .filter((task) => task.pageId === page.id)
      .map((task) => ({ title: task.title, pageVersion: task.pageVersion }));
    if (tasks.length) {
      references.push({ id, title: spec.title, state, version, tasks });
      stamps.push([id, state, version, revision]);
    }
  };

  // 1. 扫描工作空间下的流程模板草稿与已发布版本对当前页面的引用
  const { rows: templates } = await tx.query(
    "SELECT t.id, t.revision, t.latest_version, t.draft FROM process_templates t WHERE t.workspace_id = $1 ORDER BY t.id",
    [definition.workspace_id],
  );
  for (const template of templates) {
    addReference(template.id, template.draft, "draft", template.latest_version, template.revision);
  }

  const versionSql = `
    SELECT v.*
    FROM process_template_versions v
    JOIN process_templates t ON t.id = v.template_id
    WHERE t.workspace_id = $1
    ORDER BY v.template_id, v.version
  `;
  const { rows: versions } = await tx.query(versionSql, [definition.workspace_id]);
  for (const version of versions) {
    addReference(version.template_id, version.spec, "published", version.version, 0);
  }

  // 2. 统计各页面版本关联的进行中与已完成流程任务数量
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

  // 3. 汇总归档或恢复的风险提示
  const warnings: string[] = [];
  if (action === "archive" && references.some((item) => item.state === "published")) {
    warnings.push("引用此页面的流程版本将不能再发起；已发出的任务仍可处理。");
  }

  if (action === "restore") {
    const savedSql = `
      SELECT v.definition_version, v.schema, m.model
      FROM page_versions v
      JOIN data_object_versions m ON m.definition_id = v.definition_id AND m.version = v.definition_version
      WHERE v.page_id = $1 AND v.version = $2
    `;
    const saved = (await tx.query(savedSql, [page.id, page.latest_version])).rows[0];

    const latestRes = await tx.query(
      "SELECT model FROM data_object_versions WHERE definition_id = $1 AND version = $2",
      [definition.id, definition.latest_version],
    );
    const latest = latestRes.rows[0]?.model as DataModel | undefined;

    if (saved && latest) {
      const bindings = pageBindings(saved.schema);
      const changes = dataModelChanges(saved.model, latest);
      const affected = [...changes.removed, ...changes.changed].filter((item) => bindings.has(item.field.id));

      if (affected.length) {
        const fieldNames = affected.map((item) => item.field.name).join("、");
        warnings.push(
          `当前模型已调整本页使用的字段：${fieldNames}。恢复后仍按原数据 V${saved.definition_version} 使用，采用新版需另行检查。`,
        );
      } else if (saved.definition_version !== definition.latest_version) {
        warnings.push(
          `本页仍使用数据 V${saved.definition_version}，当前数据为 V${definition.latest_version}；恢复不会自动升级页面或记录。`,
        );
      }
    }

    if (page.additions.length && page.base_definition_revision !== definition.revision) {
      warnings.push("保留的新字段草稿需要重新检查数据基线后才能发布。");
    }
  }

  const pendingFieldCount = page.additions.reduce(
    (count: number, item: any) => count + 1 + item.field.children.length,
    0,
  );

  const impact: Omit<PageLifecycleImpact, "token"> = {
    pageId: page.id,
    title: page.title,
    revision: page.revision,
    action,
    archivedAt: page.archived_at ? new Date(page.archived_at).toISOString() : null,
    publishedVersion: page.latest_version,
    pendingFieldCount,
    references,
    tasks,
    warnings,
  };

  const token = createHash("sha256")
    .update(JSON.stringify(canonical({ impact, stamps, modelRevision: definition.revision })))
    .digest("hex");

  return { ...impact, token };
}
