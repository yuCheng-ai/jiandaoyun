import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { OrganizationService } from "./organization.service";
import { AccountService } from "./accounts.service";
import { DirectoryService } from "./directory.service";

/** 组织架构、外部通讯录与成员账号管理接口 */
@Controller("api/organization")
@UseGuards(AuthGuard)
export class OrganizationController {
  constructor(
    private readonly organizations: OrganizationService,
    private readonly accounts: AccountService,
    private readonly directory: DirectoryService,
  ) {}

  /** 获取当前工作空间的组织架构快照（部门、角色、角色组、成员归属） */
  @Get()
  get(@Req() r: AuthenticatedRequest) {
    return this.organizations.get(r.actor);
  }

  /** 获取当前工作空间已接入的通讯录快照 */
  @Get("directory")
  async directoryGet(@Req() r: AuthenticatedRequest) {
    return { directory: await this.directory.get(r.actor) };
  }

  /** 获取可用于通讯录角色授权的应用与表单目录列表 */
  @Get("role-applications")
  roleApplications(@Req() r: AuthenticatedRequest) {
    return this.directory.applications(r.actor);
  }

  /** 首次接入并初始化外部通讯录 */
  @Post("directory")
  directoryInitialize(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.directory.save(r.actor, b, true);
  }

  /** 保存并合并更新外部通讯录配置，同时投影至组织架构 */
  @Put("directory")
  directorySave(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.directory.save(r.actor, b);
  }

  /** 直接保存工作空间组织架构配置 */
  @Put()
  save(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.organizations.save(r.actor, b);
  }

  /** 创建新的登录账号（支持同时绑定通讯录成员） */
  @Post("accounts")
  createAccount(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.accounts.save(r.actor, b);
  }

  /** 查询指定通讯录命名空间下的成员与登录账号关联列表 */
  @Get("member-accounts")
  memberAccounts(@Req() r: AuthenticatedRequest, @Query("namespace") namespace: string) {
    return this.accounts.memberAccounts(r.actor, namespace);
  }

  /** 将通讯录成员与现有登录账号建立关联 */
  @Put("member-accounts")
  associateMember(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.accounts.associateMember(r.actor, b);
  }

  /** 更新指定登录账号的姓名、启停状态或密码 */
  @Put("accounts/:id")
  updateAccount(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.accounts.save(r.actor, b, id, r.headers.cookie);
  }
}
