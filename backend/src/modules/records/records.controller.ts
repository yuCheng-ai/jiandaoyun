import { Body, Controller, Get, Param, Put, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { CollectionService } from "./collection.service";
import { RecordViewService } from "./record-views.service";

/** 表单列表视图设置与收集规则控制接口 */
@Controller("api/definitions")
@UseGuards(AuthGuard)
export class CollectionController {
  constructor(
    private readonly collection: CollectionService,
    private readonly recordViews: RecordViewService,
  ) {}

  /** 保存更新表单的记录列表视图配置 */
  @Put(":id/record-view")
  saveView(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.recordViews.save(r.actor, id, b);
  }

  /** 获取表单收集规则配置及已提交记录统计 */
  @Get(":id/collection-rules")
  get(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.collection.get(r.actor, id);
  }

  /** 保存更新表单收集规则配置 */
  @Put(":id/collection-rules")
  save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.collection.save(r.actor, id, b);
  }

  /** 获取表单收集规则的历史修改轨迹 */
  @Get(":id/collection-rules/events")
  events(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.collection.events(r.actor, id);
  }

  /** 检查当前用户填写该表单时的实时收集开放状态 */
  @Get(":id/collection-status")
  status(@Req() r: AuthenticatedRequest, @Param("id") id: string) {
    return this.collection.status(r.actor, id);
  }
}
