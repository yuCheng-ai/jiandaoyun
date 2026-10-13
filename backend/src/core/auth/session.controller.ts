import { Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthGuard, AuthService, AuthenticatedRequest } from "./auth.service";
import { Database } from "../database/database";
import { config } from "../config/config";

/** 健康检查与用户会话（登录 / 当前身份 / 退出登录）控制器 */
@Controller("api")
export class SessionController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Database,
  ) {}

  /** 数据库连通性与服务健康检查 */
  @Get("health")
  async health() {
    await this.db.query("SELECT 1");
    return { status: "ok", mode: "local-development" };
  }

  /** 账号密码登录并下发 HttpOnly 会话 Cookie */
  @Post("auth/login")
  async login(
    @Body() body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.auth.login(
      body?.username,
      body?.password,
      req.ip || "local",
    );
    res.cookie("platform_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookie,
      path: "/api",
      maxAge: 8 * 3600 * 1000,
    });
    return user;
  }

  /** 获取当前已登录用户信息 */
  @Get("auth/me")
  @UseGuards(AuthGuard)
  me(@Req() req: AuthenticatedRequest) {
    return req.actor;
  }

  /** 退出登录并清除会话 Cookie */
  @Post("auth/logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.headers.cookie);
    res.clearCookie("platform_session", { path: "/api" });
    return { ok: true };
  }
}
