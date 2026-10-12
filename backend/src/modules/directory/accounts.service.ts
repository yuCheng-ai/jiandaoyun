import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID, scryptSync } from "node:crypto";
import type {
  AccountUser,
  MemberAccountSource,
  MemberAccountLink,
  MemberAccounts,
} from "@platform/contracts";
import {
  type Actor,
  passwordHash,
  requireAdmin,
  sessionTokenHash,
} from "../../core/auth/auth.service";
import { Database, type Transaction } from "../../core/database/database";
import { OrganizationService } from "./organization.service";
import { DirectoryService } from "./directory.service";
import { once } from "../processes/commands";
import { object, title, uuid } from "../../core/database/schema";

const columns = "id,username,name,role,active,account_revision AS revision";

function memberInput(raw: unknown): {
  source: MemberAccountSource;
  expectedRevision: number;
} {
  object(raw);
  object(raw.source);
  uuid(raw.source.namespace);
  title(raw.source.name);
  if (
    typeof raw.source.memberId !== "string" ||
    !raw.source.memberId.trim() ||
    raw.source.memberId.length > 200 ||
    /[\u0000-\u001f]/.test(raw.source.memberId) ||
    typeof raw.source.number !== "string" ||
    raw.source.number.length > 100 ||
    !Number.isSafeInteger(raw.expectedRevision) ||
    raw.expectedRevision < 0
  )
    throw new BadRequestException("成员或关联版本不合法");
  return {
    source: {
      namespace: raw.source.namespace.toLowerCase(),
      memberId: raw.source.memberId,
      name: raw.source.name.trim(),
      number: raw.source.number,
    },
    expectedRevision: raw.expectedRevision,
  };
}

@Injectable()
export class AccountService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
    private readonly directory: DirectoryService,
  ) {}

  async memberAccounts(
    actor: Actor,
    namespace: string,
  ): Promise<MemberAccounts> {
    requireAdmin(actor);
    uuid(namespace);
    return this.db.transaction(async (tx) => {
      const org = await this.organizations.snapshot(tx, actor);
      requireAdmin(org.users.find((user) => user.id === actor.id)!);
      const rows = (
        await tx.query(
          "SELECT * FROM member_accounts WHERE workspace_id=$1 AND source_namespace=$2 ORDER BY member_id",
          [actor.workspaceId, namespace],
        )
      ).rows;
      return {
        accounts: org.users,
        links: rows.map((row) =>
          this.linkDto(
            row,
            org.users.find((user) => user.id === row.account_id)!,
          ),
        ),
      };
    });
  }

  private linkDto(row: any, account: AccountUser): MemberAccountLink {
    return {
      id: row.id,
      source: {
        namespace: row.source_namespace,
        memberId: row.member_id,
        name: row.member_name,
        number: row.member_number,
      },
      revision: row.revision,
      account,
    };
  }

  private async writeMemberLink(
    tx: Transaction,
    actor: Actor,
    input: ReturnType<typeof memberInput>,
    accountId: string,
  ) {
    const { source, expectedRevision } = input;
    const directory = (
      await tx.query(
        "SELECT source_namespace,spec FROM organization_directories WHERE workspace_id=$1",
        [actor.workspaceId],
      )
    ).rows[0];
    if (directory) {
      const member = directory.spec.employees.find(
        (member: any) => member.id === source.memberId,
      );
      if (
        directory.source_namespace !== source.namespace ||
        !member ||
        member.name !== source.name ||
        member.number !== source.number
      )
        throw new ConflictException("成员资料已变化，请重新读取后关联");
      if (member.status !== "active")
        throw new ConflictException("请先将成员设为在职，再关联登录账号");
    }
    // Account writes hold the organization lock exclusively, including migration confirmation.
    const current = (
      await tx.query(
        "SELECT * FROM member_accounts WHERE workspace_id=$1 AND source_namespace=$2 AND member_id=$3 FOR UPDATE",
        [actor.workspaceId, source.namespace, source.memberId],
      )
    ).rows[0];
    if ((current?.revision || 0) !== expectedRevision)
      throw new ConflictException(
        "成员账号关联已被修改，请重新读取；当前选择已保留",
      );
    const occupied = (
      await tx.query(
        "SELECT 1 FROM member_accounts WHERE workspace_id=$1 AND source_namespace=$2 AND account_id=$3 AND member_id<>$4",
        [actor.workspaceId, source.namespace, accountId, source.memberId],
      )
    ).rowCount;
    if (occupied)
      throw new ConflictException("该账号已关联其他成员，请选择其他账号");
    if (
      (
        await tx.query(
          "SELECT 1 FROM historical_identities WHERE workspace_id=$1 AND source_namespace=$2 AND kind='member' AND source_id=$3",
          [actor.workspaceId, source.namespace, source.memberId],
        )
      ).rowCount
    )
      throw new ConflictException(
        "该成员已保留为独立历史身份，不能改为登录账号",
      );
    const batches = (
      await tx.query(
        "SELECT choices FROM migration_batches WHERE workspace_id=$1 AND source_namespace=$2 AND state='identities_confirmed'",
        [actor.workspaceId, source.namespace],
      )
    ).rows;
    for (const batch of batches)
      for (const choice of batch.choices) {
        if (choice.kind !== "member") continue;
        if (
          (choice.sourceId === source.memberId &&
            (choice.mode !== "existing" || choice.targetId !== accountId)) ||
          (choice.sourceId !== source.memberId && choice.targetId === accountId)
        )
          throw new ConflictException(
            "关联与已确认的成员身份不同，不能覆盖历史对应",
          );
      }
    const row = current
      ? (
          await tx.query(
            "UPDATE member_accounts SET account_id=$2,member_name=$3,member_number=$4,revision=revision+1 WHERE id=$1 RETURNING *",
            [current.id, accountId, source.name, source.number],
          )
        ).rows[0]
      : (
          await tx.query(
            "INSERT INTO member_accounts(id,workspace_id,source_namespace,member_id,member_name,member_number,account_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              randomUUID(),
              actor.workspaceId,
              source.namespace,
              source.memberId,
              source.name,
              source.number,
              accountId,
            ],
          )
        ).rows[0];
    await tx.query(
      "INSERT INTO member_account_events(id,link_id,actor_id,revision,detail) VALUES($1,$2,$3,$4,$5)",
      [
        randomUUID(),
        row.id,
        actor.id,
        row.revision,
        { source, previousAccountId: current?.account_id || null, accountId },
      ],
    );
    return row.id as string;
  }

  async associateMember(
    actor: Actor,
    body: unknown,
  ): Promise<MemberAccountLink> {
    requireAdmin(actor);
    object(body);
    uuid(body.requestId);
    uuid(body.accountId);
    const member = memberInput(body);
    if (!Number.isSafeInteger(body.accountRevision) || body.accountRevision < 1)
      throw new BadRequestException("账号版本不合法");
    return this.db.transaction(async (tx) => {
      await this.organizations.lock(tx, actor.workspaceId, true);
      const org = await this.organizations.snapshot(tx, actor);
      requireAdmin(org.users.find((user) => user.id === actor.id)!);
      const account = org.users.find((user) => user.id === body.accountId);
      if (!account) throw new NotFoundException("账号不存在或不属于当前组织");
      const id = await once(
        tx,
        actor,
        body.requestId,
        {
          memberAccount: member,
          accountId: body.accountId,
          accountRevision: body.accountRevision,
        },
        async () => {
          if (account.revision !== body.accountRevision)
            throw new ConflictException("账号信息已变化，请重新读取后确认");
          const linkId = await this.writeMemberLink(
            tx,
            actor,
            member,
            account.id,
          );
          await this.directory.project(tx, actor);
          return linkId;
        },
      );
      const row = (
        await tx.query(
          "SELECT * FROM member_accounts WHERE id=$1 AND workspace_id=$2",
          [id, actor.workspaceId],
        )
      ).rows[0];
      return this.linkDto(
        row,
        org.users.find((user) => user.id === row.account_id)!,
      );
    });
  }

  async save(
    actor: Actor,
    body: unknown,
    id?: string,
    cookie?: string,
  ): Promise<AccountUser> {
    requireAdmin(actor);
    object(body);
    uuid(body.requestId);
    title(body.name);
    const allowed = id
      ? ["requestId", "expectedRevision", "name", "active", "password"]
      : ["requestId", "username", "name", "password", "member"];
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw new BadRequestException("账号设置包含不支持的内容");
    const member =
      body.member === undefined ? undefined : memberInput(body.member);
    if (id) {
      uuid(id);
      if (
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 1 ||
        typeof body.active !== "boolean"
      )
        throw new BadRequestException("账号状态或版本不合法");
      if (id === actor.id && !body.active)
        throw new BadRequestException("不能停用当前登录账号");
    } else if (
      typeof body.username !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,63}$/.test(body.username)
    ) {
      throw new BadRequestException(
        "账号应为3–64位字母、数字或 _.@-，以字母或数字开头",
      );
    }
    const password = body.password;
    if (
      (!id || password !== undefined) &&
      (typeof password !== "string" ||
        !password.trim() ||
        password.length < 16 ||
        password.length > 256)
    )
      throw new BadRequestException("密码应为16–256个字符");
    // The retry fingerprint uses a slow, request-salted derivation, never plaintext credentials.
    const payload = {
      ...body,
      id,
      password:
        password === undefined
          ? undefined
          : scryptSync(password, body.requestId, 32).toString("hex"),
    };
    return this.db.transaction(async (tx) => {
      await this.organizations.lock(tx, actor.workspaceId, true);
      const organization = await this.organizations.snapshot(tx, actor);
      requireAdmin(organization.users.find((user) => user.id === actor.id)!);
      const accountId = await once(
        tx,
        actor,
        body.requestId,
        payload,
        async () => {
          let account: AccountUser;
          if (!id) {
            const result = await tx.query(
              `INSERT INTO users(id,workspace_id,username,name,role,password_hash)
            VALUES($1,$2,$3,$4,'member',$5) ON CONFLICT(username) DO NOTHING RETURNING ${columns}`,
              [
                randomUUID(),
                actor.workspaceId,
                body.username,
                body.name.trim(),
                passwordHash(password),
              ],
            );
            if (!result.rows[0])
              throw new ConflictException("该账号已存在，请使用其他账号");
            account = result.rows[0];
          } else {
            if (body.active) {
              const bound = (
                await tx.query(
                  "SELECT d.spec,m.member_id FROM organization_directories d JOIN member_accounts m ON m.workspace_id=d.workspace_id AND m.source_namespace=d.source_namespace WHERE d.workspace_id=$1 AND m.account_id=$2",
                  [actor.workspaceId, id],
                )
              ).rows[0];
              if (
                bound &&
                !bound.spec.employees.some(
                  (member: any) =>
                    member.id === bound.member_id && member.status === "active",
                )
              )
                throw new ConflictException(
                  "关联成员已停用或离职，请先恢复成员状态",
                );
            }
            const current = (
              await tx.query(
                `SELECT ${columns} FROM users WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
                [id, actor.workspaceId],
              )
            ).rows[0];
            if (!current) throw new NotFoundException("账号不存在");
            if (current.revision !== body.expectedRevision)
              throw new ConflictException(
                "账号已被修改，请重新读取后再保存；当前输入已保留",
              );
            account = (
              await tx.query(
                `UPDATE users SET name=$3,active=$4,password_hash=COALESCE($5,password_hash),account_revision=account_revision+1
            WHERE id=$1 AND workspace_id=$2 RETURNING ${columns}`,
                [
                  id,
                  actor.workspaceId,
                  body.name.trim(),
                  body.active,
                  password === undefined ? null : passwordHash(password),
                ],
              )
            ).rows[0];
            if (!body.active || password !== undefined) {
              const keep =
                id === actor.id ? sessionTokenHash(cookie) : undefined;
              await tx.query(
                "DELETE FROM sessions WHERE user_id=$1 AND ($2::text IS NULL OR token_hash<>$2)",
                [id, keep || null],
              );
            }
          }
          if (member) {
            await this.writeMemberLink(tx, actor, member, account.id);
            await this.directory.project(tx, actor);
          }
          await tx.query(
            "INSERT INTO account_events(id,workspace_id,actor_id,account_id,revision,action,detail) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              randomUUID(),
              actor.workspaceId,
              actor.id,
              account.id,
              account.revision,
              id ? "updated" : "created",
              {
                name: account.name,
                active: account.active,
                passwordChanged: password !== undefined,
              },
            ],
          );
          return account.id;
        },
      );
      // Retries return the current account state, not an old password or stale status.
      const current = (
        await tx.query(
          `SELECT ${columns} FROM users WHERE id=$1 AND workspace_id=$2`,
          [accountId, actor.workspaceId],
        )
      ).rows[0];
      if (!current) throw new NotFoundException("账号不存在");
      return current;
    });
  }
}
