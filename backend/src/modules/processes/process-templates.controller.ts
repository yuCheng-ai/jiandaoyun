import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { ProcessTemplateService } from "./process-templates.service";

@Controller("api/process-templates")
@UseGuards(AuthGuard)
export class ProcessTemplateController {
  constructor(private readonly templates: ProcessTemplateService) {}
  @Get() list(@Req() r: AuthenticatedRequest, @Query("applicationId") appId: string) { return this.templates.list(r.actor, appId); }
  @Post() create(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.templates.save(r.actor, b); }
  @Put(":id") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.templates.save(r.actor, b, id); }
  @Post(":id/publish") publish(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.templates.publish(r.actor, id, b); }
  @Get(":id/versions/:version") published(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("version") version: string) { return this.templates.published(r.actor, id, Number(version)); }
  @Get(":id/versions/:version/records") records(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("version") version: string, @Query("bindingId") bindingId: string) { return this.templates.records(r.actor, id, Number(version), bindingId); }
  @Post(":id/versions/:version/preview") preview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("version") version: string, @Body() b: unknown) { return this.templates.preview(r.actor, id, Number(version), b); }
  @Post(":id/versions/:version/start") start(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("version") version: string, @Body() b: unknown) { return this.templates.start(r.actor, id, Number(version), b); }
}
