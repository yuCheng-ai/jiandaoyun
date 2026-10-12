import { Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthGuard, AuthService, AuthenticatedRequest } from "./auth.service";
import { Database } from "../database/database";
import { config } from "../config/config";

@Controller("api")
export class SessionController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Database,
  ) {}
  @Get("health") async health() {
    await this.db.query("SELECT 1");
    return { status: "ok", mode: "local-development" };
  }
  @Post("auth/login") async login(
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
  @Get("auth/me") @UseGuards(AuthGuard) me(@Req() req: AuthenticatedRequest) {
    return req.actor;
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req.headers.cookie);
    res.clearCookie("platform_session", { path: "/api" });
    return { ok: true };
  }
}
