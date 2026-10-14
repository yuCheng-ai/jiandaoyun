import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../auth/auth.service";

/** HTTP 与后台任务共用脱敏诊断，只保留异常类别、SQLSTATE 和调用位置。 */
export function safeFailure(
  exception: unknown,
  status = exception instanceof HttpException ? exception.getStatus() : 500,
) {
  const error = exception as { stack?: unknown; code?: unknown } | undefined;
  let kind = "RequestBodyError";
  if (exception instanceof HttpException) {
    kind = exception.constructor.name;
  } else if (status === 500) {
    kind = "InternalError";
  }

  const databaseCode =
    status === 500 && typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code
      : undefined;
  let locations: string[] | undefined;
  if (status === 500 && exception instanceof Error && typeof exception.stack === "string") {
    // 错误消息可能跨行；先完整移除消息，不能把其中的“at …”误当安全调用位置。
    const heading = `${exception.name}: ${exception.message}`;
    if (exception.stack.startsWith(heading)) {
      locations = exception.stack
        .slice(heading.length)
        .split("\n")
        .filter((line) => /^\s+at /.test(line))
        .slice(0, 8)
        .map((line) => line.trim());
    }
  }

  return {
    kind,
    ...(databaseCode ? { databaseCode } : {}),
    ...(locations ? { locations } : {}),
  };
}

/**
 * 全局请求审计日志中间件：
 * - 为每个请求分配唯一 `requestId` 并通过 `X-Request-ID` 响应头返回；
 * - 每个请求仅记录一条结构化完成事件（包含守卫拦截、请求体解析失败或连接中断）；
 * - 严禁记录动态路由参数值、Query 参数、Cookie 凭据或表单字段明文。
 */
export function requestLogging(req: Request, res: Response, next: NextFunction) {
  const started = performance.now();
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  let written = false;

  const write = (aborted: boolean) => {
    if (written) return;
    written = true;

    const actor = (req as AuthenticatedRequest).actor;
    const status = aborted ? 499 : res.statusCode;

    let level: "error" | "warn" | "info" = "info";
    if (status >= 500) {
      level = "error";
    } else if (status >= 400) {
      level = "warn";
    }

    // 仅记录路由模板路径，忽略具体记录 ID、查询字符串、敏感凭据及表单内容
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      event: aborted ? "http.aborted" : "http.completed",
      requestId,
      method: req.method,
      route: typeof req.route?.path === "string" ? req.route.path : "unmatched",
      status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ...(actor ? { actorId: actor.id, workspaceId: actor.workspaceId } : {}),
      ...(res.locals.failure ? { failure: res.locals.failure } : {}),
    };

    process.stdout.write(JSON.stringify(logEntry) + "\n");
  };

  res.once("finish", () => write(false));
  res.once("close", () => write(!res.writableFinished));
  next();
}

/**
 * 全局异常过滤器：
 * - 统一格式化 HTTP 异常响应，附带 `statusCode` 与 `requestId`；
 * - 将 500 内部错误的 SQLSTATE 错误码与调用栈位置写入 `res.locals.failure` 供审计日志采集，不泄露异常原文或 SQL 参数。
 */
@Catch()
export class RequestExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const parseError = exception as
      | { statusCode?: number; stack?: string; code?: unknown }
      | undefined;
    const parserStatus = parseError?.statusCode;

    // 1. 解析 HTTP 状态码
    let status = 500;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
    } else if (
      typeof parserStatus === "number" &&
      Number.isInteger(parserStatus) &&
      parserStatus >= 400 &&
      parserStatus < 500
    ) {
      status = parserStatus;
    }

    res.locals.failure = safeFailure(exception, status);

    if (res.headersSent) return;

    // 3. 构造客户端响应载荷
    let payload: string | object;
    if (exception instanceof HttpException && status < 500) {
      payload = exception.getResponse();
    } else {
      let message = "服务暂时不可用，请稍后重试。";
      if (status === 413) {
        message = "本次内容超过接收容量";
      } else if (status === 400) {
        message = "请求内容格式不正确";
      } else if (status === 415) {
        message = "请求格式不受支持";
      }
      payload = { message };
    }

    res.status(status).json({
      ...(typeof payload === "string" ? { message: payload } : payload),
      statusCode: status,
      requestId: res.locals.requestId,
    });
  }
}
