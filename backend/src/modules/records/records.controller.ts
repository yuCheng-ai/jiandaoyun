import { Body, Controller, Get, Param, Put, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { CollectionService } from "./collection.service";
import { RecordViewService } from "./record-views.service";

@Controller("api/definitions")
@UseGuards(AuthGuard)
export class CollectionController {
  constructor(
    private readonly collection: CollectionService,
    private readonly recordViews: RecordViewService,
  ) {}
  @Put(":id/record-view") saveView(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.recordViews.save(r.actor, id, b); }
  @Get(":id/collection-rules") get(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.collection.get(r.actor, id); }
  @Put(":id/collection-rules") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.collection.save(r.actor, id, b); }
  @Get(":id/collection-rules/events") events(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.collection.events(r.actor, id); }
  @Get(":id/collection-status") status(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.collection.status(r.actor, id); }
}
