import { migrationIdentityKey, type MigrationIdentitySource, type MigrationSourceIdentity } from "@platform/contracts";
import { inspectApplicationMigration } from "../domain/applicationMigration";
import { migrationSourceStamp, readApplicationMigrationSource } from "./applicationMigrationSource";

export const MIGRATION_NAMESPACE_KEY = "business-platform.migration-source.v1";
type StoragePort = Pick<Storage, "getItem" | "setItem">;
function namespace(storage: StoragePort) {
  const current = storage.getItem(MIGRATION_NAMESPACE_KEY);
  if (current) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(current)) throw new Error("迁移来源标识无法读取，请保留原数据后联系管理员处理。");
    return current;
  }
  const next = crypto.randomUUID(); storage.setItem(MIGRATION_NAMESPACE_KEY, next);
  return next;
}
function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
/** Hash the original persisted workspace, not its compatibility projection. */
export async function migrationFingerprint(stamp: string) {
  const original = JSON.parse(stamp); delete original.recentFormIds;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(original)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
/** Called only on explicit identity-configuration entry. The business storage key is never written. */
export async function readMigrationIdentities(appId: string, storage: StoragePort = localStorage): Promise<MigrationIdentitySource> {
  const sourceNamespace = typeof navigator !== "undefined" && navigator.locks ? await navigator.locks.request(MIGRATION_NAMESPACE_KEY, { mode: "exclusive" }, () => namespace(storage)) : namespace(storage);
  const { data, stamp } = readApplicationMigrationSource(storage), report = inspectApplicationMigration(data, appId), org = data.organization;
  const items = new Map<string, MigrationSourceIdentity>();
  const queue = report.identities.map(item => ({ kind: item.kind, sourceId: item.id }));
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!, key = migrationIdentityKey(item); if (items.has(key)) continue;
    const found = item.kind === "member" ? org.employees.find(value => value.id === item.sourceId) : item.kind === "department" ? org.departments.find(value => value.id === item.sourceId) : org.roles.find(value => value.id === item.sourceId);
    items.set(key, { ...item, name: found?.name || `目录缺失（${item.sourceId}）`, found: !!found, active: !!found && ("status" in found ? found.status === "active" : !found.archived) });
    if (!found) continue;
    const add = (kind: MigrationSourceIdentity["kind"], ids: string[]) => ids.filter(Boolean).forEach(sourceId => queue.push({ kind, sourceId }));
    if (item.kind === "member") {
      const member = org.employees.find(value => value.id === item.sourceId)!;
      add("department", [...member.departmentIds, member.primaryDepartmentId]);
    } else if (item.kind === "department") {
      const department = org.departments.find(value => value.id === item.sourceId)!;
      // Include hierarchy, managers and members: department-scoped rules can refer to these implicitly.
      add("department", [department.parentId || "", ...org.departments.filter(value => value.parentId === department.id).map(value => value.id)]);
      add("member", [...department.managerIds, ...org.employees.filter(value => value.departmentIds.includes(department.id)).map(value => value.id)]);
    } else {
      const role = org.roles.find(value => value.id === item.sourceId)!;
      add("member", role.memberIds); add("department", role.departmentIds);
    }
  }
  const fingerprint = await migrationFingerprint(stamp);
  if (migrationSourceStamp(storage) !== stamp) throw new Error("读取期间应用已变化，请重新读取来源后继续。");
  return { namespace: sourceNamespace, applicationId: appId, applicationName: report.application.name, fingerprint, identities: [...items.values()].sort((a, b) => migrationIdentityKey(a).localeCompare(migrationIdentityKey(b))), counts: { forms: report.forms.length, versions: report.forms.reduce((sum, form) => sum + form.publishedVersions, 0), records: report.forms.reduce((sum, form) => sum + form.records, 0), rows: report.forms.reduce((sum, form) => sum + form.rowCount, 0), issues: report.issues.length } };
}
