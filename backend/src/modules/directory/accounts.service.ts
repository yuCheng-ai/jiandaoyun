import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  AccountUser,
  MemberAccountLink,
  MemberAccountSource,
  MemberAccounts,
} from "@platform/contracts";
import { randomUUID, scryptSync } from "node:crypto";
import {
  type Actor,
  passwordHash,
  requireAdmin,
  sessionTokenHash,
} from "../../core/auth/auth.service";
import { once } from "../../core/database/commands";
import { Database, type Transaction } from "../../core/database/database";
import { object, title, uuid } from "../../core/validation";
import { DirectoryService } from "./directory.service";
import { OrganizationService } from "./organization.service";


const USER_COLUMNS = "id, username, name, role, active, account_revision AS revision";

/** 校验并解析通讯录成员与登录账号关联的输入参数 */
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
  ) {
    throw new BadRequestException("成员或关联版本不合法");
  }

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

  /** 获取当前工作空间下的有效成员列表（仅管理员） */
  async activeUsers(actor: Actor) {
    requireAdmin(actor);
    const { rows } = await this.db.query(
      "SELECT id, name, username, role FROM users WHERE workspace_id = $1 AND active ORDER BY username",
      [actor.workspaceId],
    );
    return rows;
  }

  /** 查询指定命名空间下所有登录账号及通讯录成员绑定关系 */
  async memberAccounts(actor: Actor, namespace: string): Promise<MemberAccounts> {
    requireAdmin(actor);
    uuid(namespace);

    return this.db.transaction(async (tx) => {
      const org = await this.organizations.snapshot(tx, actor);
      requireAdmin(org.users.find((user) => user.id === actor.id)!);

      const { rows } = await tx.query(
        "SELECT * FROM member_accounts WHERE workspace_id = $1 AND source_namespace = $2 ORDER BY member_id",
        [actor.workspaceId, namespace],
      );

      return {
        accounts: org.users,
        links: rows.map((row) =>
          this.linkDto(row, org.users.find((user) => user.id === row.account_id)!),
        ),
      };
    });
  }

  /** 将数据库关联行与账号对象组装为前端 DTO */
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

  /**
   * 写入通讯录成员与登录账号的关联关系：
   * 1. 核对成员在当前通讯录中的姓名、工号与在职状态；
   * 2. 校验并发版本号与一对一唯一约束；
   * 3. 校验未与历史独立身份或已确认的迁移身份决议冲突；
   * 4. 更新或插入关联记录并记录审计事件。
   */
  private async writeMemberLink(
    tx: Transaction,
    actor: Actor,
    input: ReturnType<typeof memberInput>,
    accountId: string,
  ): Promise<string> {
    const { source, expectedRevision } = input;

    // 1. 若已接入通讯录，校验成员资料一致且处于在职状态
    const { rows: dirRows } = await tx.query(
      "SELECT source_namespace, spec FROM organization_directories WHERE workspace_id = $1",
      [actor.workspaceId],
    );
    const directory = dirRows[0];
    if (directory) {
      const member = directory.spec.employees.find((item: any) => item.id === source.memberId);
      if (
        directory.source_namespace !== source.namespace ||
        !member ||
        member.name !== source.name ||
        member.number !== source.number
      ) {
        throw new ConflictException("成员资料已变化，请重新读取后关联");
      }
      if (member.status !== "active") {
        throw new ConflictException("请先将成员设为在职，再关联登录账号");
      }
    }

    // 2. 锁定当前成员关联记录（外层已持有组织级排他锁）并校验乐观锁版本
    const { rows: curRows } = await tx.query(
      "SELECT * FROM member_accounts WHERE workspace_id = $1 AND source_namespace = $2 AND member_id = $3 FOR UPDATE",
      [actor.workspaceId, source.namespace, source.memberId],
    );
    const current = curRows[0];
    if ((current?.revision || 0) !== expectedRevision) {
      throw new ConflictException("成员账号关联已被修改，请重新读取；当前选择已保留");
    }

    // 3. 校验目标登录账号未被同一命名空间下的其他成员占用
    const { rowCount: occupied } = await tx.query(
      "SELECT 1 FROM member_accounts WHERE workspace_id = $1 AND source_namespace = $2 AND account_id = $3 AND member_id <> $4",
      [actor.workspaceId, source.namespace, accountId, source.memberId],
    );
    if (occupied) {
      throw new ConflictException("该账号已关联其他成员，请选择其他账号");
    }

    // 4. 校验该成员未被保留为独立历史身份
    const { rowCount: isHistorical } = await tx.query(
      "SELECT 1 FROM historical_identities WHERE workspace_id = $1 AND source_namespace = $2 AND kind = 'member' AND source_id = $3",
      [actor.workspaceId, source.namespace, source.memberId],
    );
    if (isHistorical) {
      throw new ConflictException("该成员已保留为独立历史身份，不能改为登录账号");
    }

    // 5. 保存关联关系并写入审计事件
    let row: any;
    if (current) {
      const { rows } = await tx.query(
        "UPDATE member_accounts SET account_id = $2, member_name = $3, member_number = $4, revision = revision + 1 WHERE id = $1 RETURNING *",
        [current.id, accountId, source.name, source.number],
      );
      row = rows[0];
    } else {
      const sql = `
        INSERT INTO member_accounts (
          id, workspace_id, source_namespace, member_id, member_name, member_number, account_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `;
      const { rows } = await tx.query(sql, [
        randomUUID(),
        actor.workspaceId,
        source.namespace,
        source.memberId,
        source.name,
        source.number,
        accountId,
      ]);
      row = rows[0];
    }

    await tx.query(
      "INSERT INTO member_account_events (id, link_id, actor_id, revision, detail) VALUES ($1, $2, $3, $4, $5)",
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

  /** 将通讯录成员绑定到现有登录账号，并重新投影组织架构 */
  async associateMember(actor: Actor, body: unknown): Promise<MemberAccountLink> {
    requireAdmin(actor);
    object(body);
    uuid(body.requestId);
    uuid(body.accountId);

    const member = memberInput(body);
    if (!Number.isSafeInteger(body.accountRevision) || body.accountRevision < 1) {
      throw new BadRequestException("账号版本不合法");
    }

    return this.db.transaction(async (tx) => {
      await this.organizations.lock(tx, actor.workspaceId, true);
      const org = await this.organizations.snapshot(tx, actor);
      requireAdmin(org.users.find((user) => user.id === actor.id)!);

      const account = org.users.find((user) => user.id === body.accountId);
      if (!account) {
        throw new NotFoundException("账号不存在或不属于当前组织");
      }

      const payload = {
        memberAccount: member,
        accountId: body.accountId,
        accountRevision: body.accountRevision,
      };

      const id = await once(tx, actor, body.requestId, payload, async () => {
        if (account.revision !== body.accountRevision) {
          throw new ConflictException("账号信息已变化，请重新读取后确认");
        }
        const linkId = await this.writeMemberLink(tx, actor, member, account.id);
        await this.directory.project(tx, actor);
        return linkId;
      });

      const { rows } = await tx.query(
        "SELECT * FROM member_accounts WHERE id = $1 AND workspace_id = $2",
        [id, actor.workspaceId],
      );
      const row = rows[0];
      return this.linkDto(row, org.users.find((user) => user.id === row.account_id)!);
    });
  }

  /**
   * 创建或更新登录账号：
   * - 新建账号时支持可选地同时关联通讯录成员；
   * - 更新账号时支持修改姓名、启停状态与密码，并在停用或改密时清理旧会话。
   */
  async save(actor: Actor, body: unknown, id?: string, cookie?: string): Promise<AccountUser> {
    requireAdmin(actor);
    object(body);
    uuid(body.requestId);
    title(body.name);

    const allowed = id
      ? ["requestId", "expectedRevision", "name", "active", "password"]
      : ["requestId", "username", "name", "password", "member"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      throw new BadRequestException("账号设置包含不支持的内容");
    }

    const member = body.member === undefined ? undefined : memberInput(body.member);

    if (id) {
      uuid(id);
      if (
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 1 ||
        typeof body.active !== "boolean"
      ) {
        throw new BadRequestException("账号状态或版本不合法");
      }
      if (id === actor.id && !body.active) {
        throw new BadRequestException("不能停用当前登录账号");
      }
    } else if (
      typeof body.username !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,63}$/.test(body.username)
    ) {
      throw new BadRequestException("账号应为3–64位字母、数字或 _.@-，以字母或数字开头");
    }

    const password = body.password;
    if (
      (!id || password !== undefined) &&
      (typeof password !== "string" ||
        !password.trim() ||
        password.length < 16 ||
        password.length > 256)
    ) {
      throw new BadRequestException("密码应为16–256个字符");
    }

    // 幂等请求指纹使用以 requestId 加盐的慢哈希，绝不落盘明文密码
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

      const accountId = await once(tx, actor, body.requestId, payload, async () => {
        let account: AccountUser;

        if (!id) {
          const insertSql = `
            INSERT INTO users (id, workspace_id, username, name, role, password_hash)
            VALUES ($1, $2, $3, $4, 'member', $5)
            ON CONFLICT (username) DO NOTHING
            RETURNING ${USER_COLUMNS}
          `;
          const { rows } = await tx.query(insertSql, [
            randomUUID(),
            actor.workspaceId,
            body.username,
            body.name.trim(),
            passwordHash(password),
          ]);
          if (!rows[0]) {
            throw new ConflictException("该账号已存在，请使用其他账号");
          }
          account = rows[0];
        } else {
          // 启用已关联成员的账号前，确认对应通讯录成员处于在职状态
          if (body.active) {
            const boundSql = `
              SELECT d.spec, m.member_id
              FROM organization_directories d
              JOIN member_accounts m
                ON m.workspace_id = d.workspace_id
                AND m.source_namespace = d.source_namespace
              WHERE d.workspace_id = $1
                AND m.account_id = $2
            `;
            const { rows: boundRows } = await tx.query(boundSql, [actor.workspaceId, id]);
            const bound = boundRows[0];
            if (
              bound &&
              !bound.spec.employees.some(
                (emp: any) => emp.id === bound.member_id && emp.status === "active",
              )
            ) {
              throw new ConflictException("关联成员已停用或离职，请先恢复成员状态");
            }
          }

          const { rows: curRows } = await tx.query(
            `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
            [id, actor.workspaceId],
          );
          const current = curRows[0];
          if (!current) throw new NotFoundException("账号不存在");
          if (current.revision !== body.expectedRevision) {
            throw new ConflictException("账号已被修改，请重新读取后再保存；当前输入已保留");
          }

          const updateSql = `
            UPDATE users
            SET
              name = $3,
              active = $4,
              password_hash = COALESCE($5, password_hash),
              account_revision = account_revision + 1
            WHERE id = $1 AND workspace_id = $2
            RETURNING ${USER_COLUMNS}
          `;
          const { rows: updatedRows } = await tx.query(updateSql, [
            id,
            actor.workspaceId,
            body.name.trim(),
            body.active,
            password === undefined ? null : passwordHash(password),
          ]);
          account = updatedRows[0];

          // 停用账号或修改密码后，清理该用户的历史登录会话（若操作人修改自身密码则保留当前会话）
          if (!body.active || password !== undefined) {
            const keep = id === actor.id ? sessionTokenHash(cookie) : undefined;
            await tx.query(
              "DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)",
              [id, keep || null],
            );
          }
        }

        if (member) {
          await this.writeMemberLink(tx, actor, member, account.id);
          await this.directory.project(tx, actor);
        }

        await tx.query(
          "INSERT INTO account_events (id, workspace_id, actor_id, account_id, revision, action, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)",
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
      });

      // 幂等重试时同样返回最新的账号实时状态
      const { rows } = await tx.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND workspace_id = $2`,
        [accountId, actor.workspaceId],
      );
      const current = rows[0];
      if (!current) throw new NotFoundException("账号不存在");
      return current;
    });
  }
}
