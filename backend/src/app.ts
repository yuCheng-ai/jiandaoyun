import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { json } from "express";
import { AppModule } from "./app.module";
import { config } from "./core/config/config";
import { Database } from "./core/database/database";
import { passwordHash } from "./core/auth/auth.service";
import { randomUUID } from "node:crypto";
import { ApplicationService } from "./modules/applications/applications.service";
import { upgradeDataProjection } from "./modules/records/data-projection";
import { requestLogging, RequestExceptionFilter } from "./core/logging/request-logging";

export { AppModule };

/**
 * 创建并初始化 NestJS 应用实例：
 * 1. 挂载请求审计日志与全局异常过滤器；
 * 2. 配置安全响应头与写操作 Origin 校验（防范 CSRF）；
 * 3. 统一限制 JSON 请求体为 1MB；
 * 4. 执行数据库迁移、数据投影升级以及默认账号与应用种子数据初始化。
 */
export async function createApp() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });

  app.use(requestLogging);
  app.useGlobalFilters(new RequestExceptionFilter());

  const allowedOrigins = new Set([config.origin]);
  const appOrigin = new URL(config.origin);
  // 本地开发的两个回环地址共用同一前端，仍严格限制协议和端口。
  if (["127.0.0.1", "localhost"].includes(appOrigin.hostname)) {
    appOrigin.hostname =
      appOrigin.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
    allowedOrigins.add(appOrigin.origin);
  }

  // 安全响应头与非只读请求的来源（Origin）校验
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (!isSafeMethod && !allowedOrigins.has(req.headers.origin || "")) {
      return res.status(403).json({
        message: "请求来源不合法",
        requestId: res.locals.requestId,
      });
    }
    next();
  });

  app.use(json({ limit: "1mb" }));

  try {
    const db = app.get(Database);
    await db.migrate();
    await upgradeDataProjection(db);
    await seedLocalAccounts(db);
    await app.get(ApplicationService).seed();
    app.enableShutdownHooks();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

/** 当前产品的本地账号初始化属于启动编排，认证模块不预设用户或工作空间。 */
async function seedLocalAccounts(db: Database) {
  const accounts = [
    ["admin", "平台管理员", "admin", process.env.PLATFORM_ADMIN_PASSWORD],
    ["editor", "录入成员", "member", process.env.PLATFORM_EDITOR_PASSWORD],
    ["reviewer", "核对成员", "member", process.env.PLATFORM_REVIEWER_PASSWORD],
  ] as const;

  for (const [username, name, role, password] of accounts) {
    if (!password || password.length < 16) {
      throw new Error("Local account passwords of at least 16 characters are required.");
    }

    const sql = `
      INSERT INTO users (id, workspace_id, username, name, role, password_hash)
      VALUES ($1, 'local', $2, $3, $4, $5)
      ON CONFLICT (username) DO NOTHING
    `;
    await db.query(sql, [randomUUID(), username, name, role, passwordHash(password)]);
  }
}