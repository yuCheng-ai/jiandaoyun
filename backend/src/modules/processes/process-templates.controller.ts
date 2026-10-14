import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { ProcessTemplateService } from "./process-templates.service";

/** 任务模板管理与基于模板发起流程接口 */
@Controller("api/process-templates")
@UseGuards(AuthGuard)
export class ProcessTemplateController {
  constructor(private readonly templates: ProcessTemplateService) {}

  /** 获取指定应用下的任务模板列表 */
  @Get()
  list(@Req() r: AuthenticatedRequest, @Query("applicationId") appId: string) {
    return this.templates.list(r.actor, appId);
  }

  /** 新建任务模板草稿 */
  @Post()
  create(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.templates.save(r.actor, b);
  }

  /** 保存更新指定任务模板草稿 */
  @Put(":id")
  save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.templates.save(r.actor, b, id);
  }

  /** 发布任务模板新版本 */
  @Post(":id/publish")
  publish(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.templates.publish(r.actor, id, b);
  }

  @Put(":id/state")
  setEnabled(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.templates.setEnabled(r.actor, id, b);
  }

  @Get(":id/versions")
  versions(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.templates.versions(r.actor, id);
  }

  @Delete(":id/versions/:version")
  removeVersion(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("version") version: string,
    @Body() b: unknown,
  ) {
    return this.templates.removeVersion(r.actor, id, Number(version), b);
  }

  /** 获取已发布的任务模板指定版本详情 */
  @Get(":id/versions/:version")
  published(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("version") version: string,
  ) {
    return this.templates.readVersion(r.actor, id, Number(version));
  }

  /** 查询与模板业务数据绑定兼容的可选业务记录列表 */
  @Get(":id/versions/:version/records")
  records(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("version") version: string,
    @Query("bindingId") bindingId: string,
  ) {
    return this.templates.records(r.actor, id, Number(version), bindingId);
  }

  /** 预览根据已发布模板与所选记录展开后的任务列表 */
  @Post(":id/versions/:version/preview")
  preview(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("version") version: string,
    @Body() b: unknown,
  ) {
    return this.templates.preview(r.actor, id, Number(version), b);
  }

  /** 基于已发布模板正式发起流程 */
  @Post(":id/versions/:version/start")
  start(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("version") version: string,
    @Body() b: unknown,
  ) {
    return this.templates.start(r.actor, id, Number(version), b);
  }
}

/** 对外保留原表单提交地址，在同一事务内协调记录与流程。 */
@Controller("api/pages")
@UseGuards(AuthGuard)
export class FormSubmissionController {
  constructor(private readonly templates: ProcessTemplateService) {}

  @Post(":id/records")
  create(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.templates.submitPage(r.actor, id, b);
  }

  @Post(":id/records/:recordId/submit")
  submit(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Body() b: unknown) {
    return this.templates.submitPage(r.actor, id, b, recordId);
  }
}
