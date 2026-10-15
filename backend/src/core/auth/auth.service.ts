import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { SessionUser } from "@platform/contracts";
import { Database } from "../database/database";

/** 当前请求的操作者上下文，只承载已认证身份与工作空间。 */
export interface Actor extends SessionUser {
  workspaceId: string;
}

/** 已通过身份认证的 HTTP 请求对象 */
export interface AuthenticatedRequest extends Request {
  actor: Actor;
}

// ============================================================================
// 1. 令牌与密码哈希工具函数
// ============================================================================

/** 计算会话令牌的 SHA-256 摘要（数据库中仅存储摘要，不存明文令牌） */
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

/** 从 Cookie 请求头中提取 `platform_session` 并计算其哈希摘要 */
export function sessionTokenHash(cookie = ""): string | undefined {
  const token = cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("platform_session="))
    ?.slice("platform_session=".length);
  return token ? tokenHash(token) : undefined;
}

/** 使用随机盐值与 scrypt 算法生成密码哈希（格式：`salt:hash`） */
export function passwordHash(value: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(value, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/** 恒定时间比对密码明文与已存储的哈希值，防范时序攻击 */
function verifyPassword(value: string, encoded: string): boolean {
  const [salt, hash] = encoded.split(":");
  const actual = scryptSync(value, salt!, 64);
  const expected = Buffer.from(hash!, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 将数据库用户行映射为对外公开的 Actor 结构 */
function publicUser(row: any): Actor {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    workspaceId: row.workspace_id,
  };
}

// ============================================================================
// 2. 认证与会话服务
// ============================================================================

@Injectable()
export class AuthService {
  /** 登录失败频率限制表：记录 `${ip}:${username}` 的连续失败次数与锁定期限 */
  private failures = new Map<string, { count: number; until: number }>();

  /** 虚拟密码哈希：当用户名不存在时参与空转计算，消除账号枚举时序差异 */
  private dummyHash = passwordHash(randomBytes(32).toString("hex"));

  constructor(private readonly db: Database) {}

  /** 校验账号密码并创建有效期 8 小时的登录会话 */
  async login(username: unknown, password: unknown, ip: string) {
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 100 ||
      password.length > 256
    ) {
      throw new UnauthorizedException("账号或密码不正确");
    }

    const key = `${ip}:${username}`;
    const prior = this.failures.get(key);
    if (prior && prior.until > Date.now() && prior.count >= 8) {
      throw new UnauthorizedException("尝试次数过多，请稍后重试");
    }

    return this.db.transaction(async (tx) => {
      // 加行锁串行化密码验证与会话创建，确保与账号停用/改密操作并发安全
      const { rows } = await tx.query(
        "SELECT * FROM users WHERE username=$1 AND active FOR UPDATE",
        [username],
      );
      const row = rows[0];
      const valid = verifyPassword(password, row?.password_hash || this.dummyHash);

      if (!row || !valid) {
        if (this.failures.size > 10000) this.failures.clear();
        const isWindowActive = prior && prior.until > Date.now();
        this.failures.set(key, {
          count: isWindowActive ? prior.count + 1 : 1,
          until: Date.now() + 60000,
        });
        throw new UnauthorizedException("账号或密码不正确");
      }

      this.failures.delete(key);
      const token = randomBytes(32).toString("base64url");
      await tx.query(
        "INSERT INTO sessions VALUES ($1, $2, now() + interval '8 hours')",
        [tokenHash(token), row.id],
      );
      return { token, user: publicUser(row) };
    });
  }

  /** 根据请求 Cookie 解析并校验当前登录用户 */
  async actor(cookie = ""): Promise<Actor> {
    const hash = sessionTokenHash(cookie);
    if (!hash) {
      throw new UnauthorizedException("请先登录");
    }

    const sql = `
      SELECT u.*
      FROM users u
      JOIN sessions s ON s.user_id = u.id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND u.active
    `;
    const { rows } = await this.db.query(sql, [hash]);
    const row = rows[0];
    if (!row) {
      throw new UnauthorizedException("登录已失效，请重新登录");
    }
    return publicUser(row);
  }

  /** 销毁当前 Cookie 对应的服务端会话 */
  async logout(cookie = "") {
    const hash = sessionTokenHash(cookie);
    if (hash) {
      await this.db.query("DELETE FROM sessions WHERE token_hash = $1", [hash]);
    }
  }
}

// ============================================================================
// 3. 路由守卫与管理员断言
// ============================================================================

/** 登录态守卫：只验证服务端会话并填充当前身份。 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.actor = await this.auth.actor(request.headers.cookie);

    return true;
  }
}

/** 校验当前操作者是否为系统管理员 */
export function requireAdmin(actor: Pick<Actor, "role">) {
  if (actor.role !== "admin") {
    throw new ForbiddenException("需要管理员权限");
  }
}
