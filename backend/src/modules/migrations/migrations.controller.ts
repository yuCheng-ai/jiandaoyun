import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { MigrationIdentityService } from "./migration-identities.service";
import { MigrationResourceService } from "./migration-resources.service";
import { MigrationOrganizationService } from "./migration-organization.service";
import { ApplicationImportService } from "./application-import.service";
import { RecordOriginService } from "./record-origins.service";

/**
 * 迁移批次控制器：
 * 管理历史应用迁移的身份映射、组织关系预览与导入、资源快照准备以及应用全量导入。
 */
@Controller("api/migration-batches")
@UseGuards(AuthGuard)
export class MigrationIdentityController {
  constructor(
    private readonly migrations: MigrationIdentityService,
    private readonly resources: MigrationResourceService,
    private readonly organizationImport: MigrationOrganizationService,
    private readonly applicationImport: ApplicationImportService,
  ) {}

  /** 查询指定来源命名空间下的迁移批次列表 */
  @Get()
  list(
    @Req() r: AuthenticatedRequest,
    @Query("namespace") namespace: string,
    @Query("applicationId") applicationId?: string,
  ) {
    return this.migrations.list(r.actor, namespace, applicationId);
  }

  /** 创建新的迁移批次并初始化身份映射草稿 */
  @Post()
  create(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.migrations.create(r.actor, b);
  }

  /** 获取单个迁移批次详情 */
  @Get(":id")
  get(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.migrations.get(r.actor, id);
  }

  /** 查询迁移批次的操作审计事件列表 */
  @Get(":id/events")
  events(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.migrations.events(r.actor, id);
  }

  /** 预览组织架构关系导入的变更与阻塞项 */
  @Post(":id/organization-preview")
  organizationPreview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.organizationImport.review(r.actor, id, b);
  }

  /** 执行组织架构关系导入 */
  @Post(":id/organization-import")
  importOrganization(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.organizationImport.apply(r.actor, id, b);
  }

  /** 获取迁移批次最新的资源检查计划快照 */
  @Get(":id/resources")
  resourcesGet(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.resources.get(r.actor, id);
  }

  /** 生成并保存迁移资源检查计划快照 */
  @Post(":id/resources")
  resourcesPrepare(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.resources.prepare(r.actor, id, b);
  }

  /** 按已通过检查的资源快照执行应用全量导入 */
  @Post(":id/application-import")
  importApplication(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.applicationImport.apply(r.actor, id, b);
  }

  /** 保存身份映射选择草稿 */
  @Put(":id")
  save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.migrations.save(r.actor, id, b);
  }

  /** 刷新来源身份清单并保留已有的身份映射选择 */
  @Post(":id/source")
  source(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.migrations.save(r.actor, id, b, true);
  }

  /** 检查当前批次的身份映射完整性与冲突情况 */
  @Post(":id/review")
  review(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.migrations.review(r.actor, id, b);
  }

  /** 确认当前批次的身份映射并归档保留历史身份 */
  @Post(":id/confirm-identities")
  confirm(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.migrations.confirm(r.actor, id, b);
  }

  /** 撤销身份映射确认，重新回到草稿编辑状态 */
  @Post(":id/reopen")
  reopen(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.migrations.confirm(r.actor, id, b, true);
  }
}

/**
 * 历史记录来源档案控制器：
 * 供管理员查询迁移导入记录的原始版本、创建者及历史轨迹元数据。
 */
@Controller("api/records")
@UseGuards(AuthGuard)
export class RecordOriginController {
  constructor(private readonly origins: RecordOriginService) {}

  /** 获取指定记录的迁移来源档案（仅管理员可访问） */
  @Get(":id/origin")
  get(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.origins.get(r.actor, id);
  }
}
