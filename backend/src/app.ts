import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { json } from "express";
import { AppModule } from "./app.module";
import { config } from "./core/config/config";
import { Database } from "./core/database/database";
import { AuthService } from "./core/auth/auth.service";
import { ApplicationService } from "./modules/applications/applications.service";
import { upgradeDataProjection } from "./modules/records/data-projection";
import { requestLogging, RequestExceptionFilter } from "./core/logging/request-logging";

export { AppModule };

/**
 * 创建并初始化 NestJS 应用实例：
 * 1. 挂载请求审计日志与全局异常过滤器；
 * 2. 配置安全响应头与写操作 Origin 校验（防范 CSRF）；
 * 3. 配置 JSON 请求体大小限制（迁移批次接口放宽至 16MB，常规接口 1MB）；
 * 4. 执行数据库迁移、数据投影升级以及默认账号与应用种子数据初始化。
 */
export async function createApp() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });

  app.use(requestLogging);
  app.useGlobalFilters(new RequestExceptionFilter());

  // 安全响应头与非只读请求的来源（Origin）校验
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (!isSafeMethod && req.headers.origin !== config.origin) {
      return res.status(403).json({
        message: "请求来源不合法",
        requestId: res.locals.requestId,
      });
    }
    next();
  });

  app.use("/api/migration-batches", json({ limit: "16mb" }));
  app.use(json({ limit: "1mb" }));

  try {
    const db = app.get(Database);
    await db.migrate();
    await upgradeDataProjection(db);
    await app.get(AuthService).seed();
    await app.get(ApplicationService).seed();
    app.enableShutdownHooks();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
