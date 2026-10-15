import { AccountService } from "../directory/accounts.service";
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
import { RecordAccessGuard, RecordAccessRequest } from "../access/access.service";
import { RecordService } from "../records/records.service";
import { FileService, type UploadedFile } from "../records/files.service";
import { CollectionService } from "./collection.service";
import { RecordViewService } from "./record-views.service";


/** 表单列表视图设置与收集规则控制接口 */
@Controller("api/definitions")
@UseGuards(RecordAccessGuard)
export class CollectionController {
  constructor(
    private readonly collection: CollectionService,
    private readonly recordViews: RecordViewService,
  ) {}

  /** 保存更新表单的记录列表视图配置 */
  @Put(":id/record-view")
  saveView(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.recordViews.save(r.actor, id, b);
  }

  /** 获取表单收集规则配置及已提交记录统计 */
  @Get(":id/collection-rules")
  get(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.collection.get(r.actor, id);
  }

  /** 保存更新表单收集规则配置 */
  @Put(":id/collection-rules")
  save(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.collection.save(r.actor, id, b);
  }

  /** 获取表单收集规则的历史修改轨迹 */
  @Get(":id/collection-rules/events")
  events(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.collection.events(r.actor, id);
  }

  /** 检查当前用户填写该表单时的实时收集开放状态 */
  @Get(":id/collection-status")
  status(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.collection.status(r.actor, id);
  }
}

/**
 * 表单定义与通用记录平台路由控制器
 */
@Controller("api")
@UseGuards(RecordAccessGuard)
export class RecordController {
  constructor(
    private readonly recordService: RecordService,
    private readonly accounts: AccountService,
    private readonly files: FileService,
  ) {}

  @Post("files")
  @UseInterceptors(FileInterceptor("file", {
    defParamCharset: "utf8",
    limits: { fileSize: 500 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  }))
  uploadFile(@Req() request: RecordAccessRequest, @UploadedFileBody() file?: UploadedFile) {
    return this.files.upload(request.actor, file);
  }

  @Get("files/:id")
  async downloadFile(
    @Req() request: RecordAccessRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.recordService.downloadFile(request.actor, id);
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    return new StreamableFile(file.content, {
      type: file.type,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      length: file.content.length,
    });
  }

  @Delete("files/:id")
  async discardFile(@Req() request: RecordAccessRequest, @Param("id") id: string) {
    await this.files.discard(request.actor, id);
    return { discarded: true };
  }

  /** 获取表单组织字段的候选成员/部门列表与默认值 */
  @Post("definitions/:id/organization-options")
  organizationOptions(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.recordService.organizationOptions(r.actor, id, b);
  }

  /** 获取当前工作空间下的有效成员列表（仅管理员） */
  @Get("users")
  users(@Req() r: RecordAccessRequest) {
    return this.accounts.activeUsers(r.actor);
  }

  /** 获取指定记录下已删除且支持恢复的子表明细行列表 */
  @Get("records/:id/removed-rows")
  removedRows(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.recordService.removedRows(r.actor, id);
  }

  /** 获取指定表单定义下的记录列表 */
  @Get("definitions/:id/records")
  records(@Req() r: RecordAccessRequest, @Param("id") id: string, @Query("state") state?: string) {
    return this.recordService.records(r.actor, id, state);
  }

  /** 在指定表单定义下创建新记录或草稿 */
  @Post("definitions/:id/records")
  add(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.recordService.createRecord(r.actor, id, b);
  }

  /** 获取单条记录详情 */
  @Get("records/:id")
  detail(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.recordService.detail(r.actor, id);
  }

  /** 增量修改单条记录的字段值或子表明细行 */
  @Patch("records/:id")
  patch(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.recordService.patchRecord(r.actor, id, b);
  }

  /** 将草稿记录正式提交生效 */
  @Post("records/:id/submit")
  submitRecord(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.recordService.submitRecord(r.actor, id, b);
  }

  /** 导出或打印单条记录 */
  @Get("records/:id/output/:action")
  output(@Req() r: RecordAccessRequest, @Param("id") id: string, @Param("action") action: string) {
    return this.recordService.output(r.actor, id, action);
  }

  /** 获取单条记录的变更审计事件列表 */
  @Get("records/:id/events")
  events(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.recordService.events(r.actor, id);
  }

  /** 归档指定记录 */
  @Post("records/:id/archive")
  archive(@Req() r: RecordAccessRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.recordService.archiveRecord(r.actor, id, b);
  }
}
