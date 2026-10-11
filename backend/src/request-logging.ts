import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "./auth";

/** One completion event per request, including guard, parser and origin failures. */
export function requestLogging(
  req: Request,
  res: Response,
  next: NextFunction,
) {
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
    // Route templates omit record IDs, query parameters, secrets and form values.
    process.stdout.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        event: aborted ? "http.aborted" : "http.completed",
        requestId,
        method: req.method,
        route:
          typeof req.route?.path === "string" ? req.route.path : "unmatched",
        status,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        ...(actor ? { actorId: actor.id, workspaceId: actor.workspaceId } : {}),
        ...(res.locals.failure ? { failure: res.locals.failure } : {}),
      }) + "\n",
    );
  };
  res.once("finish", () => write(false));
  res.once("close", () => write(!res.writableFinished));
  next();
}

@Catch()
export class RequestExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const parseError = exception as
      { statusCode?: number; stack?: string; code?: unknown } | undefined;
    const parserStatus = parseError?.statusCode;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : typeof parserStatus === "number" &&
            Number.isInteger(parserStatus) &&
            parserStatus >= 400 &&
            parserStatus < 500
          ? parserStatus
          : 500;
    res.locals.failure = {
      kind:
        exception instanceof HttpException
          ? exception.constructor.name
          : status === 500
            ? "InternalError"
            : "RequestBodyError",
      // SQLSTATE identifies the database failure without exposing query values.
      ...(status === 500 &&
      typeof parseError?.code === "string" &&
      /^[0-9A-Z]{5}$/.test(parseError.code)
        ? { databaseCode: parseError.code }
        : {}),
      // Stack locations help locate faults without logging exception messages or SQL values.
      ...(status === 500 && typeof parseError?.stack === "string"
        ? {
            locations: parseError.stack
              .split("\n")
              .slice(1)
              .filter((line) => /^\s+at /.test(line))
              .slice(0, 8)
              .map((line) => line.trim()),
          }
        : {}),
    };
    if (res.headersSent) return;
    const payload =
      exception instanceof HttpException && status < 500
        ? exception.getResponse()
        : {
            message:
              status === 413
                ? "本次内容超过接收容量"
                : status === 400
                  ? "请求内容格式不正确"
                  : status === 415
                    ? "请求格式不受支持"
                    : "服务暂时不可用，请稍后重试。",
          };
    res.status(status).json({
      ...(typeof payload === "string" ? { message: payload } : payload),
      statusCode: status,
      requestId: res.locals.requestId,
    });
  }
}
