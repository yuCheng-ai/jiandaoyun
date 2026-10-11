import {
  organizationSubjectMembers,
  roleGrantMatches,
  type AccessPolicy,
  type DirectoryIdentity,
  type DirectorySpec,
  type ServerOrganization,
} from "@platform/contracts";
import type { Actor } from "./auth";
import type { Database } from "./database";

type Queryable = Pick<Database, "query">;
export type RuntimePolicy = AccessPolicy & { allFormFields?: true };

/** Source aliases become executable only after a complete application import. */
export async function directoryApplications(
  tx: Queryable,
  actor: Actor,
  namespace: string | null,
  definitionId?: string,
) {
  return (
    await tx.query(
      `SELECT a.id AS application_id,a.title AS application_title,d.id,d.title,
    i.source_application_id,f.value->>'sourceId' AS source_form_id,
    COALESCE(g.config->>'mode'='groups',false) AS grouped
    FROM applications a LEFT JOIN definitions d ON d.application_id=a.id
    LEFT JOIN record_permission_groups g ON g.definition_id=d.id
    LEFT JOIN application_imports i ON i.application_id=a.id AND i.workspace_id=a.workspace_id AND i.source_namespace=$2
    LEFT JOIN migration_resource_snapshots s ON s.id=i.snapshot_id
    LEFT JOIN LATERAL jsonb_array_elements(s.projection->'forms') f(value) ON f.value->>'definitionId'=d.id::text
    WHERE a.workspace_id=$1 AND ($3::uuid IS NULL OR d.id=$3)
    ORDER BY a.created_at,a.id,d.created_at,d.id`,
      [actor.workspaceId, namespace, definitionId || null],
    )
  ).rows;
}

/** Read the current directory, never a second persisted copy of its grants. */
export async function directoryRolePolicies(
  tx: Queryable,
  actor: Actor,
  organization: ServerOrganization,
  definitionId?: string,
): Promise<{ definitionId: string; policy: RuntimePolicy }[]> {
  const row = (
    await tx.query(
      "SELECT source_namespace,spec,identities FROM organization_directories WHERE workspace_id=$1",
      [actor.workspaceId],
    )
  ).rows[0];
  if (!row) return [];
  const identities = row.identities as DirectoryIdentity[];
  const grants = (row.spec as DirectorySpec).roles
    .filter((role) => {
      const target = identities.find(
        (item) => item.kind === "role" && item.id === role.id,
      );
      return (
        !role.archived &&
        target &&
        organizationSubjectMembers(organization.spec, {
          kind: "role",
          id: target.targetId,
        }).includes(actor.id)
      );
    })
    .flatMap((role) => role.grants)
    .filter((grant) => grant.actions.length);
  if (!grants.length) return [];
  return (
    await directoryApplications(tx, actor, row.source_namespace, definitionId)
  ).flatMap((form) =>
    grants
      .filter(
        (grant) =>
          form.id &&
          roleGrantMatches(
            grant,
            form.application_id,
            form.id,
            form.source_application_id,
            form.source_form_id,
          ),
      )
      .map((grant) => ({
        definitionId: form.id,
        policy: {
          read:
            grant.actions.includes("view") || grant.actions.includes("manage"),
          create: grant.actions.includes("submit"),
          edit: grant.actions.includes("manage"),
          remove: grant.actions.includes("manage"),
          scope: grant.dataScope,
          fields: {},
          allFormFields: true as const,
        },
      })),
  );
}
