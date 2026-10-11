import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { Request } from "express";
import type { SessionUser } from "@platform/contracts";
import { Database } from "./database";

export interface Actor extends SessionUser {
  workspaceId: string;
  accessGroups?: Record<string, string>;
}
export interface AuthenticatedRequest extends Request {
  actor: Actor;
}
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function sessionTokenHash(cookie = "") {
  const token = cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("platform_session="))
    ?.slice(17);
  return token ? tokenHash(token) : undefined;
}
export function passwordHash(value: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
}
function verifyPassword(value: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  const actual = scryptSync(value, salt!, 64);
  const expected = Buffer.from(hash!, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const publicUser = (row: any): Actor => ({
  id: row.id,
  name: row.name,
  username: row.username,
  role: row.role,
  workspaceId: row.workspace_id,
});

@Injectable()
export class AuthService {
  private failures = new Map<string, { count: number; until: number }>();
  private dummyHash = passwordHash(randomBytes(32).toString("hex"));
  constructor(private readonly db: Database) {}
  async seed() {
    const accounts = [
      ["admin", "平台管理员", "admin", process.env.PLATFORM_ADMIN_PASSWORD],
      ["editor", "录入成员", "member", process.env.PLATFORM_EDITOR_PASSWORD],
      [
        "reviewer",
        "核对成员",
        "member",
        process.env.PLATFORM_REVIEWER_PASSWORD,
      ],
    ];
    for (const [username, name, role, password] of accounts) {
      if (!password || password.length < 16)
        throw new Error(
          "Local account passwords of at least 16 characters are required.",
        );
      await this.db.query(
        `INSERT INTO users(id,workspace_id,username,name,role,password_hash)
        VALUES($1,'local',$2,$3,$4,$5) ON CONFLICT(username) DO NOTHING`,
        [randomUUID(), username, name, role, passwordHash(password)],
      );
    }
  }
  async login(username: unknown, password: unknown, ip: string) {
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 100 ||
      password.length > 256
    )
      throw new UnauthorizedException("账号或密码不正确");
    const key = `${ip}:${username}`;
    const prior = this.failures.get(key);
    if (prior && prior.until > Date.now() && prior.count >= 8)
      throw new UnauthorizedException("尝试次数过多，请稍后重试");
    return this.db.transaction(async (tx) => {
      // Serialize password verification and session creation with account changes.
      const row = (
        await tx.query(
          "SELECT * FROM users WHERE username=$1 AND active FOR UPDATE",
          [username],
        )
      ).rows[0];
      const valid = verifyPassword(
        password,
        row?.password_hash || this.dummyHash,
      );
      if (!row || !valid) {
        if (this.failures.size > 10000) this.failures.clear();
        this.failures.set(key, {
          count: prior && prior.until > Date.now() ? prior.count + 1 : 1,
          until: Date.now() + 60000,
        });
        throw new UnauthorizedException("账号或密码不正确");
      }
      this.failures.delete(key);
      const token = randomBytes(32).toString("base64url");
      await tx.query(
        "INSERT INTO sessions VALUES($1,$2,now()+interval '8 hours')",
        [tokenHash(token), row.id],
      );
      return { token, user: publicUser(row) };
    });
  }
  async actor(cookie = "") {
    const hash = sessionTokenHash(cookie);
    if (!hash) throw new UnauthorizedException("请先登录");
    const row = (
      await this.db.query(
        `SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,
        [hash],
      )
    ).rows[0];
    if (!row) throw new UnauthorizedException("登录已失效，请重新登录");
    return publicUser(row);
  }
  async logout(cookie = "") {
    const hash = sessionTokenHash(cookie);
    if (hash)
      await this.db.query("DELETE FROM sessions WHERE token_hash=$1", [hash]);
  }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.actor = await this.auth.actor(request.headers.cookie);
    const header = request.headers["x-platform-access-groups"];
    if (header !== undefined) {
      try {
        if (typeof header !== "string" || header.length > 12000)
          throw new Error();
        const choices = JSON.parse(header);
        if (
          !choices ||
          typeof choices !== "object" ||
          Array.isArray(choices) ||
          Object.keys(choices).length > 50
        )
          throw new Error();
        for (const [key, value] of Object.entries(choices))
          if (
            !/^[0-9a-f-]{36}$/i.test(key) ||
            typeof value !== "string" ||
            !value ||
            value.length > 200
          )
            throw new Error();
        request.actor.accessGroups = choices;
      } catch {
        throw new BadRequestException("权限组选择格式不合法");
      }
    }
    return true;
  }
}
export function requireAdmin(actor: Pick<Actor, "role">) {
  if (actor.role !== "admin") throw new ForbiddenException("需要管理员权限");
}
