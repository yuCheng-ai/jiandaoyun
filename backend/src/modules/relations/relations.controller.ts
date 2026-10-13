import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { RelationService } from "./relations.service";
import { PageService } from "../pages/pages.service";

/** 跨表单关联关系配置与记录关联操作接口 */
@Controller("api")
@UseGuards(AuthGuard)
export class RelationController {
  constructor(
    private readonly relations: RelationService,
    private readonly pages: PageService,
  ) {}

  /** 获取关联关系定义列表（支持按表单定义 ID 过滤） */
  @Get("relations")
  list(@Req() r: AuthenticatedRequest, @Query("definitionId") id?: string) {
    return this.relations.list(r.actor, id);
  }

  /** 创建新的关联关系草稿 */
  @Post("relations")
  create(@Req() r: AuthenticatedRequest, @Body() b: unknown) {
    return this.relations.save(r.actor, b);
  }

  /** 更新已有关联关系草稿配置 */
  @Put("relations/:id")
  save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.relations.save(r.actor, b, id);
  }

  /** 发布关联关系配置，生成新的生效版本 */
  @Post("relations/:id/publish")
  publish(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.relations.publish(r.actor, id, b);
  }

  /** 获取指定记录下的所有正向与反向关联分组数据 */
  @Get("records/:recordId/relations")
  record(@Req() r: AuthenticatedRequest, @Param("recordId") recordId: string) {
    return this.relations.forRecord(r.actor, recordId);
  }

  /** 分页搜索指定记录与关联关系下的可关联候选记录 */
  @Get("records/:recordId/relations/:id/candidates")
  candidates(
    @Req() r: AuthenticatedRequest,
    @Param("recordId") recordId: string,
    @Param("id") id: string,
    @Query("rowId") rowId?: string,
    @Query("cursor") cursor?: string,
    @Query("q") q?: string,
  ) {
    return this.relations.candidates(r.actor, recordId, id, rowId, cursor, q);
  }

  /** 建立记录关联关系并执行字段回填 */
  @Post("records/:recordId/relations/:id/links")
  link(
    @Req() r: AuthenticatedRequest,
    @Param("recordId") recordId: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.relations.link(r.actor, recordId, id, b);
  }

  /** 解除指定的记录关联关系 */
  @Post("records/:recordId/relations/:id/links/:linkId/remove")
  unlink(
    @Req() r: AuthenticatedRequest,
    @Param("recordId") recordId: string,
    @Param("id") id: string,
    @Param("linkId") linkId: string,
    @Body() b: unknown,
  ) {
    return this.relations.unlink(r.actor, recordId, id, linkId, b);
  }

  /** 在自定义页面上下文中获取指定记录的关联分组数据 */
  @Get("pages/:pageId/records/:recordId/relations")
  async pageRelations(
    @Req() r: AuthenticatedRequest,
    @Param("pageId") pageId: string,
    @Param("recordId") recordId: string,
    @Query("version") version: string,
  ) {
    const scope = await this.pages.recordScope(r.actor, pageId, Number(version));
    return this.relations.forRecord(r.actor, recordId, scope);
  }

  /** 在自定义页面上下文中分页搜索可关联候选记录 */
  @Get("pages/:pageId/records/:recordId/relations/:id/candidates")
  async pageCandidates(
    @Req() r: AuthenticatedRequest,
    @Param("pageId") pageId: string,
    @Param("recordId") recordId: string,
    @Param("id") id: string,
    @Query("version") version: string,
    @Query("rowId") rowId?: string,
    @Query("cursor") cursor?: string,
    @Query("q") q?: string,
  ) {
    const scope = await this.pages.recordScope(r.actor, pageId, Number(version));
    return this.relations.candidates(r.actor, recordId, id, rowId, cursor, q, scope);
  }

  /** 在自定义页面上下文中建立记录关联关系并执行回填 */
  @Post("pages/:pageId/records/:recordId/relations/:id/links")
  async pageLink(
    @Req() r: AuthenticatedRequest,
    @Param("pageId") pageId: string,
    @Param("recordId") recordId: string,
    @Param("id") id: string,
    @Body() b: any,
  ) {
    const scope = await this.pages.recordScope(r.actor, pageId, b?.pageVersion);
    return this.relations.link(r.actor, recordId, id, b, scope);
  }

  /** 在自定义页面上下文中解除指定的记录关联关系 */
  @Post("pages/:pageId/records/:recordId/relations/:id/links/:linkId/remove")
  async pageUnlink(
    @Req() r: AuthenticatedRequest,
    @Param("pageId") pageId: string,
    @Param("recordId") recordId: string,
    @Param("id") id: string,
    @Param("linkId") linkId: string,
    @Body() b: any,
  ) {
    const scope = await this.pages.recordScope(r.actor, pageId, b?.pageVersion);
    return this.relations.unlink(r.actor, recordId, id, linkId, b, scope);
  }
}
