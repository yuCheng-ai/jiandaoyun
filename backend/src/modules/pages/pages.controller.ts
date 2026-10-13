import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile as UploadedFileBody,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { PlatformService } from "./platform.service";
import { PageService } from "./pages.service";
import { FileService, type UploadedFile } from "./files.service";

/**
 * 表单定义与通用记录平台路由控制器
 */
@Controller("api")
@UseGuards(AuthGuard)
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly files: FileService,
  ) {}

  @Post("files")
  @UseInterceptors(FileInterceptor("file", {
    defParamCharset: "utf8",
    limits: { fileSize: 500 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  }))
  uploadFile(@Req() request: AuthenticatedRequest, @UploadedFileBody() file?: UploadedFile) {
    return this.files.upload(request.actor, file);
  }

  @Get("files/:id")
  async downloadFile(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.platform.downloadFile(request.actor, id);
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    return new StreamableFile(file.content, {
      type: file.type,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      length: file.content.length,
    });
  }

  @Delete("files/:id")
  async discardFile(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    await this.files.discard(request.actor, id);
    return { discarded: true };
  }

  /** 获取表单组织字段的候选成员/部门列表与默认值 */
  @Post("definitions/:id/organization-options")
  organizationOptions(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.organizationOptions(r.actor, id, b);
  }

  /** 获取当前工作空间下的有效成员列表（仅管理员） */
  @Get("users")
  users(@Req() r: AuthenticatedRequest) {
    return this.platform.users(r.actor);
  }

  /** 获取指定记录下已删除且支持恢复的子表明细行列表 */
  @Get("records/:id/removed-rows")
  removedRows(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.platform.removedRows(r.actor, id);
  }

  /** 获取当前用户可访问的表单定义列表 */
  @Get("definitions")
  definitions(@Req() r: AuthenticatedRequest) {
    return this.platform.definitions(r.actor);
  }

  /** 预览表单定义发布对关联页面、关系、流程及记录的影响 */
  @Post("definitions/:id/publish-preview")
  definitionImpact(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.modelImpact(r.actor, id, b, true);
  }

  /** 新建表单定义草稿 */
  @Post("definitions")
  create(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.platform.saveDefinition(r.actor, b);
  }

  /** 保存指定表单定义草稿 */
  @Put("definitions/:id")
  save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.saveDefinition(r.actor, b, id);
  }

  /** 发布表单定义新版本 */
  @Post("definitions/:id/publish")
  publish(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.publish(r.actor, id, b);
  }

  /** 获取已发布的最新表单定义与填写上下文 */
  @Get("definitions/:id")
  published(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.platform.published(r.actor, id);
  }

  /** 获取指定表单定义下的记录列表 */
  @Get("definitions/:id/records")
  records(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Query("state") state?: string) {
    return this.platform.records(r.actor, id, state);
  }

  /** 在指定表单定义下创建新记录或草稿 */
  @Post("definitions/:id/records")
  add(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.createRecord(r.actor, id, b);
  }

  /** 获取单条记录详情 */
  @Get("records/:id")
  detail(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.platform.detail(r.actor, id);
  }

  /** 增量修改单条记录的字段值或子表明细行 */
  @Patch("records/:id")
  patch(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.patchRecord(r.actor, id, b);
  }

  /** 将草稿记录正式提交生效 */
  @Post("records/:id/submit")
  submitRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.submitRecord(r.actor, id, b);
  }

  /** 导出或打印单条记录 */
  @Get("records/:id/output/:action")
  output(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("action") action: string) {
    return this.platform.output(r.actor, id, action);
  }

  /** 获取单条记录的变更审计事件列表 */
  @Get("records/:id/events")
  events(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.platform.events(r.actor, id);
  }

  /** 归档指定记录 */
  @Post("records/:id/archive")
  archive(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.archiveRecord(r.actor, id, b);
  }
}

/**
 * 数据对象与表单页面（设计器、发布生命周期与页面级记录管理）路由控制器
 */
@Controller("api")
@UseGuards(AuthGuard)
export class PageController {
  constructor(
    private readonly pages: PageService,
    private readonly platform: PlatformService,
  ) {}

  /** 获取应用下的数据对象列表 */
  @Get("data-objects")
  objects(@Req() r: AuthenticatedRequest, @Query("applicationId") appId?: string) {
    return this.platform.definitions(r.actor, appId);
  }

  /** 获取数据对象的草稿配置 */
  @Get("data-objects/:id/draft")
  object(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.pages.objectDraft(r.actor, id);
  }

  /** 获取数据对象下各页面暂存的待发布新字段汇总 */
  @Get("data-objects/:id/pending-page-fields")
  pendingFields(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.pages.pendingFields(r.actor, id);
  }

  /** 获取数据对象的最新已发布模型与草稿概况 */
  @Get("data-objects/:id/published-model")
  latestModel(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.pages.latestModel(r.actor, id);
  }

  /** 新建数据对象草稿 */
  @Post("data-objects")
  createObject(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.pages.saveObject(r.actor, b);
  }

  /** 保存指定数据对象草稿 */
  @Put("data-objects/:id")
  saveObject(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.saveObject(r.actor, b, id);
  }

  /** 发布指定数据对象新版本 */
  @Post("data-objects/:id/publish")
  publishObject(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.publishObject(r.actor, id, b);
  }

  /** 预览数据对象发布的影响范围 */
  @Post("data-objects/:id/publish-preview")
  objectImpact(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.platform.modelImpact(r.actor, id, b);
  }

  /** 放弃数据对象的未发布草稿修改，恢复至最新已发布版本 */
  @Post("data-objects/:id/discard-draft")
  discardObject(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.discardObjectDraft(r.actor, id, b);
  }

  /** 获取数据对象指定版本号的模型定义 */
  @Get("data-objects/:id/versions/:version")
  model(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("version") version: string) {
    return this.pages.publishedModel(r.actor, id, Number(version));
  }

  /** 获取页面列表（支持按数据对象、应用、活跃/归档状态过滤） */
  @Get("pages")
  list(
    @Req() r: AuthenticatedRequest,
    @Query("definitionId") id?: string,
    @Query("applicationId") appId?: string,
    @Query("state") state?: string,
  ) {
    return this.pages.list(r.actor, id, appId, state);
  }

  /** 一键新建表单页面及其专属底层数据对象 */
  @Post("pages/new-business")
  newBusiness(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.pages.createWithObject(r.actor, b);
  }

  /** 获取表单页面设计器完整上下文（草稿、数据对象、模型与字段编辑权限） */
  @Get("pages/:id/editor")
  editor(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.pages.editor(r.actor, id);
  }

  /** 在指定页面版本下解析组织字段的候选项与默认值 */
  @Post("pages/:id/organization-options")
  organizationOptions(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.organizationOptions(r.actor, id, b);
  }

  /** 获取已发布页面的填写表单结构、默认值与字段权限 */
  @Get("pages/:id/form")
  form(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Query("version") version?: string) {
    return this.pages.form(r.actor, id, version ? Number(version) : undefined);
  }

  /** 获取页面草稿详情 */
  @Get("pages/:id/draft")
  draft(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.pages.draft(r.actor, id);
  }

  /** 获取页面指定已发布版本的配置与数据模型 */
  @Get("pages/:id")
  published(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("version") version?: string,
  ) {
    return this.pages.published(r.actor, id, version ? Number(version) : undefined);
  }

  /** 新建页面草稿 */
  @Post("pages")
  create(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.pages.save(r.actor, b);
  }

  /** 保存页面草稿 */
  @Put("pages/:id")
  save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.save(r.actor, b, id);
  }

  /** 发布页面新版本（含关联的模型变更自动发布） */
  @Post("pages/:id/publish")
  publish(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.publish(r.actor, id, b);
  }

  /** 预览页面发布的影响范围 */
  @Post("pages/:id/publish-preview")
  publishPreview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.publishPreview(r.actor, id, b);
  }

  /** 预览页面归档或恢复的影响范围 */
  @Post("pages/:id/lifecycle-preview")
  lifecyclePreview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.lifecyclePreview(r.actor, id, b);
  }

  /** 归档指定页面 */
  @Post("pages/:id/archive")
  archivePage(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.lifecycle(r.actor, id, b, "archive");
  }

  /** 恢复已归档的页面 */
  @Post("pages/:id/restore")
  restorePage(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.lifecycle(r.actor, id, b, "restore");
  }

  /** 放弃页面的未发布草稿修改，恢复至最新已发布版本 */
  @Post("pages/:id/discard-draft")
  discardPage(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.discardDraft(r.actor, id, b);
  }

  /** 分页并按视图配置查询页面下的记录列表 */
  @Get("pages/:id/record-list")
  recordList(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("version") version?: string,
    @Query("state") state?: string,
    @Query("page") page?: string,
  ) {
    return this.pages.recordList(
      r.actor,
      id,
      version ? Number(version) : undefined,
      state,
      page === undefined ? 1 : Number(page),
    );
  }

  /** 查询页面下的记录摘要列表 */
  @Get("pages/:id/records")
  records(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("version") version?: string,
    @Query("state") state?: string,
  ) {
    return this.pages.records(r.actor, id, version ? Number(version) : undefined, state);
  }

  /** 按页面视野获取单条记录详情 */
  @Get("pages/:id/records/:recordId")
  record(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Query("version") version?: string,
  ) {
    return this.pages.record(r.actor, id, recordId, version ? Number(version) : undefined);
  }

  /** 按页面视野获取单条记录下已删除的子表明细行 */
  @Get("pages/:id/records/:recordId/removed-rows")
  removedPageRows(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Query("version") version?: string,
  ) {
    return this.pages.removedRows(r.actor, id, recordId, version ? Number(version) : undefined);
  }

  /** 预览将记录升级到当前页面所绑定数据版本的变更计划 */
  @Get("pages/:id/records/:recordId/upgrade")
  upgradePreview(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Query("version") version?: string,
  ) {
    return this.pages.recordUpgrade(
      r.actor,
      id,
      recordId,
      { pageVersion: version ? Number(version) : undefined },
      true,
    );
  }

  /** 将记录升级到当前页面所绑定的数据版本 */
  @Post("pages/:id/records/:recordId/upgrade")
  upgradeRecord(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Body() b: unknown,
  ) {
    return this.pages.recordUpgrade(r.actor, id, recordId, b);
  }

  /** 在指定页面版本下修改已有记录 */
  @Patch("pages/:id/records/:recordId")
  patchRecord(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Body() b: unknown,
  ) {
    return this.pages.writeRecord(r.actor, id, b, recordId);
  }
}
