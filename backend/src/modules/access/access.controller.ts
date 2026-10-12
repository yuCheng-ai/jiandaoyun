import { Body, Controller, Get, Param, Put, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { GroupConfigurationService } from "./group-config.service";

@Controller("api/definitions")
@UseGuards(AuthGuard)
export class GroupConfigurationController {
  constructor(private readonly groups: GroupConfigurationService) {}
  @Get(":id/permission-groups") get(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.groups.get(r.actor, id); }
  @Put(":id/permission-groups") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.groups.save(r.actor, id, body); }
  @Get(":id/permission-groups/options") options(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.groups.options(r.actor, id); }
}
