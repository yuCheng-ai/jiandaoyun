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

export async function createApp() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  app.use(requestLogging);
  app.useGlobalFilters(new RequestExceptionFilter());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      return res.status(403).json({ message: "请求来源不合法", requestId: res.locals.requestId });
    next();
  });
  app.use("/api/migration-batches", json({ limit: "16mb" }));
  app.use(json({ limit: "1mb" }));
  try {
    await app.get(Database).migrate();
    await upgradeDataProjection(app.get(Database));
    await app.get(AuthService).seed();
    await app.get(ApplicationService).seed();
    app.enableShutdownHooks();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
