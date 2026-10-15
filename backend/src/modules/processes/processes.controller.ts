import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { RecordAccessGuard, RecordAccessRequest } from "../access/access.service";
import { ProcessService } from "./processes.service";

/** 流程运行时与任务协同接口 */
@Controller("api")
@UseGuards(RecordAccessGuard)
export class ProcessesController {
  constructor(private readonly processes: ProcessService) {}

  /** 直接发起流程实例 */
  @Post("processes")
  process(@Req() r: RecordAccessRequest, @Body() b: unknown) {
    return this.processes.create(r.actor, b);
  }

  /** 按应用和范围（待办 todo / 我发起的 started / 我处理的 handled）查询流程列表 */
  @Get("processes")
  processesList(
    @Req() r: RecordAccessRequest,
    @Query("applicationId") applicationId?: string,
    @Query("scope") scope?: string,
  ) {
    return this.processes.list(r.actor, applicationId, scope);
  }

  /** 获取流程详情及当前用户可见的任务与流转事件 */
  @Get("processes/:id")
  processGet(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.processes.get(r.actor, id);
  }

  /** 按当前身份打开流程正文，前端不从任务列表猜测申请单。 */
  @Get("processes/:id/record")
  processRecord(@Req() r: RecordAccessRequest, @Param("id") id: string) {
    return this.processes.record(r.actor, id);
  }

  /** 完成指定任务节点并推进后续依赖任务 */
  @Post("processes/:id/tasks/:taskId/complete")
  complete(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("taskId") tid: string,
  ) {
    return this.processes.get(r.actor, id, tid);
  }

  @Get("processes/:id/tasks/:taskId/delegate-options")
  delegateOptions(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
  ) {
    return this.processes.delegateOptions(r.actor, id, taskId);
  }

  @Post("processes/:id/tasks/:taskId/delegate")
  delegate(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
    @Body() b: unknown,
  ) {
    return this.processes.delegate(r.actor, id, taskId, b);
  }

  /** 读取任务节点绑定的业务记录视图与权限上下文 */
  @Get("processes/:id/tasks/:taskId/record")
  taskRecord(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("taskId") tid: string,
  ) {
    return this.processes.taskRecord(r.actor, id, tid);
  }

  /** 在任务节点上下文中保存更新绑定的业务记录数据 */
  @Patch("processes/:id/tasks/:taskId/record")
  taskWrite(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("taskId") tid: string,
    @Body() b: unknown,
  ) {
    return this.processes.taskRecord(r.actor, id, tid, b);
  }

  /** 在任务节点上下文中查询成员/部门选择字段的可选范围 */
  @Post("processes/:id/tasks/:taskId/organization-options")
  taskOrganizationOptions(
    @Req() r: RecordAccessRequest,
    @Param("id") id: string,
    @Param("taskId") tid: string,
    @Body() b: unknown,
  ) {
    return this.processes.taskOrganizationOptions(r.actor, id, tid, b);
  }
}
