import { Body, Controller, Get, Param, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { GroupConfigurationService } from "./group-config.service";

/** 表单记录权限组配置与可选列表控制器 */
@Controller("api/definitions")
@UseGuards(AuthGuard)
export class GroupConfigurationController {
  constructor(private readonly groups: GroupConfigurationService) {}

  /** 获取指定表单的权限组完整配置（仅管理员） */
  @Get(":id/permission-groups")
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.groups.get(req.actor, id);
  }

  /** 保存指定表单的权限组配置（仅管理员） */
  @Put(":id/permission-groups")
  save(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.groups.save(req.actor, id, body);
  }

  /** 获取当前用户在指定表单下可切换的权限组选项列表 */
  @Get(":id/permission-groups/options")
  options(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.groups.options(req.actor, id);
  }
}

/** 从同一套表单权限组查询组织成员与角色的授权，不维护第二套角色授权。 */
@Controller("api/organization/permissions")
@UseGuards(AuthGuard)
export class OrganizationPermissionsController {
  constructor(private readonly groups: GroupConfigurationService) {}

  @Get()
  get(
    @Req() req: AuthenticatedRequest,
    @Query("memberId") memberId?: string,
    @Query("roleId") roleId?: string,
  ) {
    return this.groups.organizationPermissions(req.actor, memberId, roleId);
  }
}
