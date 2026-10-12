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
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { ProcessService } from "./processes.service";

@Controller("api")
@UseGuards(AuthGuard)
export class ProcessesController {
  constructor(private readonly processes: ProcessService) {}
  @Post("processes") process(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.processes.create(r.actor, b); }
  @Get("processes") processesList(@Req() r: AuthenticatedRequest, @Query("applicationId") applicationId?: string, @Query("scope") scope?: string) { return this.processes.list(r.actor, applicationId, scope); }
  @Get("processes/:id") processGet(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.processes.get(r.actor, id); }
  @Post("processes/:id/tasks/:taskId/complete") complete(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("taskId") tid: string) { return this.processes.get(r.actor, id, tid); }
  @Get("processes/:id/tasks/:taskId/record") taskRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("taskId") tid: string) { return this.processes.taskRecord(r.actor, id, tid); }
  @Patch("processes/:id/tasks/:taskId/record") taskWrite(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("taskId") tid: string, @Body() b: unknown) { return this.processes.taskRecord(r.actor, id, tid, b); }
  @Post("processes/:id/tasks/:taskId/organization-options") taskOrganizationOptions(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("taskId") tid: string, @Body() b: unknown) { return this.processes.taskOrganizationOptions(r.actor, id, tid, b); }
}
