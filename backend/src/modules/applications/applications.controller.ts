import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { ApplicationService } from "./applications.service";

/** 应用列表查询与新建控制器 */
@Controller("api/applications")
@UseGuards(AuthGuard)
export class ApplicationsController {
  constructor(private readonly applications: ApplicationService) {}

  /** 获取当前登录用户可见的应用列表 */
  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.applications.list(req.actor);
  }

  /** 创建新应用（仅管理员） */
  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.applications.create(req.actor, body);
  }
}
