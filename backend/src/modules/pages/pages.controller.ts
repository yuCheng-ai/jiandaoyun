import { ModelService } from "./models.service";
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { RecordAccessGuard, RecordAccessRequest } from "../access/access.service";
import { PageService } from "./pages.service";


/**
 * 数据对象与表单页面（设计器、发布生命周期与页面级记录管理）路由控制器
 */
@Controller("api")
@UseGuards(RecordAccessGuard)
export class PageController {
  constructor(
    private readonly pages: PageService,
    private readonly models: ModelService,
  ) {}

  /** 获取应用下的数据对象列表 */
  @Get("data-objects")
  objects(@Req() r: RecordAccessRequest, @Query("applicationId") appId?: string) {
    return this.models.definitions(r.actor, appId);
  }

  /** 获取数据对象的草稿配置 */
  @Get("data-objects/:id/draft")
  object(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.pages.objectDraft(r.actor, id);
  }

  /** 获取数据对象下各页面暂存的待发布新字段汇总 */
  @Get("data-objects/:id/pending-page-fields")
  pendingFields(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.pages.pendingFields(r.actor, id);
  }

  /** 获取数据对象的最新已发布模型与草稿概况 */
  @Get("data-objects/:id/published-model")
  latestModel(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.pages.latestModel(r.actor, id);
  }

  /** 新建数据对象草稿 */
  @Post("data-objects")
  createObject(@Req() r: RecordAccessRequest, @Body() b: unknown) {
    return this.pages.saveObject(r.actor, b);
  }

  /** 保存指定数据对象草稿 */
  @Put("data-objects/:id")
  saveObject(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.saveObject(r.actor, b, id);
  }

  /** 发布指定数据对象新版本 */
  @Post("data-objects/:id/publish")
  publishObject(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.publishObject(r.actor, id, b);
  }

  /** 预览数据对象发布的影响范围 */
  @Post("data-objects/:id/publish-preview")
  objectImpact(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.models.modelImpact(r.actor, id, b);
  }

  /** 放弃数据对象的未发布草稿修改，恢复至最新已发布版本 */
  @Post("data-objects/:id/discard-draft")
  discardObject(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.discardObjectDraft(r.actor, id, b);
  }

  /** 获取数据对象指定版本号的模型定义 */
  @Get("data-objects/:id/versions/:version")
  model(@Req() r: RecordAccessRequest, @Param("id") id: string, @Param("version") version: string) {
    return this.pages.publishedModel(r.actor, id, Number(version));
  }

  /** 获取页面列表（支持按数据对象、应用、活跃/归档状态过滤） */
  @Get("pages")
  list(
    @Req() r: RecordAccessRequest,
    @Query("definitionId") id?: string,
    @Query("applicationId") appId?: string,
    @Query("state") state?: string,
  ) {
    return this.pages.list(r.actor, id, appId, state);
  }

  /** 一键新建表单页面及其专属底层数据对象 */
  @Post("pages/new-business")
  newBusiness(@Req() r: RecordAccessRequest, @Body() b: unknown) {
    return this.pages.createWithObject(r.actor, b);
  }

  /** 获取表单页面设计器完整上下文（草稿、数据对象、模型与字段编辑权限） */
  @Get("pages/:id/editor")
  editor(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.pages.editor(r.actor, id);
  }

  /** 在指定页面版本下解析组织字段的候选项与默认值 */
  @Post("pages/:id/organization-options")
  organizationOptions(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.organizationOptions(r.actor, id, b);
  }

  /** 获取已发布页面的填写表单结构、默认值与字段权限 */
  @Get("pages/:id/form")
  form(@Req() r: RecordAccessRequest, @Param("id") id: string, @Query("version") version?: string) {
    return this.pages.form(r.actor, id, version ? Number(version) : undefined);
  }

  /** 获取页面草稿详情 */
  @Get("pages/:id/draft")
  draft(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.pages.draft(r.actor, id);
  }

  /** 获取页面已发布版本的快照摘要 */
  @Get("pages/:id/versions")
  versions(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.pages.versions(r.actor, id);
  }

  /** 获取页面指定已发布版本的配置与数据模型 */
  @Get("pages/:id")
  published(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Query("version") version?: string,
  ) {
    return this.pages.published(r.actor, id, version ? Number(version) : undefined);
  }

  /** 新建页面草稿 */
  @Post("pages")
  create(@Req() r: RecordAccessRequest, @Body() b: unknown) {
    return this.pages.save(r.actor, b);
  }

  /** 保存页面草稿 */
  @Put("pages/:id")
  save(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.save(r.actor, b, id);
  }

  /** 发布页面新版本（含关联的模型变更自动发布） */
  @Post("pages/:id/publish")
  publish(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.publish(r.actor, id, b);
  }

  /** 预览页面发布的影响范围 */
  @Post("pages/:id/publish-preview")
  publishPreview(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.publishPreview(r.actor, id, b);
  }

  /** 预览页面归档或恢复的影响范围 */
  @Post("pages/:id/lifecycle-preview")
  lifecyclePreview(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.lifecyclePreview(r.actor, id, b);
  }

  /** 归档指定页面 */
  @Post("pages/:id/archive")
  archivePage(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.lifecycle(r.actor, id, b, "archive");
  }

  /** 恢复已归档的页面 */
  @Post("pages/:id/restore")
  restorePage(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.lifecycle(r.actor, id, b, "restore");
  }

  /** 放弃页面的未发布草稿修改，恢复至最新已发布版本 */
  @Post("pages/:id/discard-draft")
  discardPage(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.pages.discardDraft(r.actor, id, b);
  }

  /** 分页并按视图配置查询页面下的记录列表 */
  @Get("pages/:id/record-list")
  recordList(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Query("version") version?: string,
    @Query("state") state?: string,
    @Query("page") page?: string,
    @Query("keyword") keyword?: string,
  ) {
    return this.pages.recordList(
      r.actor,
      id,
      version ? Number(version) : undefined,
      state,
      page === undefined ? 1 : Number(page),
      keyword,
    );
  }

  /** 查询页面下的记录摘要列表 */
  @Get("pages/:id/records")
  records(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Query("version") version?: string,
    @Query("state") state?: string,
  ) {
    return this.pages.records(r.actor, id, version ? Number(version) : undefined, state);
  }

  /** 按页面视野获取单条记录详情 */
  @Get("pages/:id/records/:recordId")
  record(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Query("version") version?: string,
  ) {
    return this.pages.record(r.actor, id, recordId, version ? Number(version) : undefined);
  }

  /** 按页面视野获取单条记录下已删除的子表明细行 */
  @Get("pages/:id/records/:recordId/removed-rows")
  removedPageRows(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Query("version") version?: string,
  ) {
    return this.pages.removedRows(r.actor, id, recordId, version ? Number(version) : undefined);
  }

  /** 预览将记录升级到当前页面所绑定数据版本的变更计划 */
  @Get("pages/:id/records/:recordId/upgrade")
  upgradePreview(
    @Req() r: RecordAccessRequest,
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
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Body() b: unknown,
  ) {
    return this.pages.recordUpgrade(r.actor, id, recordId, b);
  }

  /** 在指定页面版本下修改已有记录 */
  @Patch("pages/:id/records/:recordId")
  patchRecord(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("recordId") recordId: string,
    @Body() b: unknown,
  ) {
    return this.pages.writeRecord(r.actor, id, b, recordId);
  }

  /** 获取当前用户可访问的表单定义列表 */
  @Get("definitions")
  definitions(@Req() r: RecordAccessRequest) {
    return this.models.definitions(r.actor);
  }

  /** 获取已发布的最新表单定义与填写上下文 */
  @Get("definitions/:id")
  publishedDefinition(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.models.published(r.actor, id);
  }
}
