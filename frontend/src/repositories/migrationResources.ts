import type { MigrationResourceSource } from "@platform/contracts";
import { readApplicationMigrationSource, migrationSourceStamp } from "./applicationMigrationSource";
import { migrationFingerprint, readMigrationIdentities } from "./migrationIdentities";

/** Retain raw selected resources; never serialize the compatibility projection as an archive. */
export async function readMigrationResources(appId: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): Promise<MigrationResourceSource> {
  const identities = await readMigrationIdentities(appId, storage);
  const { stamp } = readApplicationMigrationSource(storage), original = JSON.parse(stamp);
  if (identities.fingerprint !== await migrationFingerprint(stamp) || migrationSourceStamp(storage) !== stamp) throw new Error("应用内容已变化，请重新读取迁移来源。");
  const forms = original.forms.filter((item: any) => item.appId === appId), ids = new Set(forms.map((item: any) => item.id));
  const byForm = (items: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(items || {}).filter(([id]) => ids.has(id)));
  return { format: 1, namespace: identities.namespace, applicationId: appId, fingerprint: identities.fingerprint, application: original.apps.find((item: any) => item.id === appId), forms, entries: original.entries.filter((item: any) => ids.has(item.formId)), access: byForm(original.formAccess), recordViews: byForm(original.recordViews), roles: (original.organization?.roles || []).filter((role: any) => role.grants.some((grant: any) => grant.appId === appId || grant.formIds.some((id: string) => ids.has(id)))), orders: (original.paymentOrders || []).filter((item: any) => ids.has(item.formId)), runs: (original.extensionRuns || []).filter((item: any) => ids.has(item.formId)) };
}
