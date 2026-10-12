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

@Controller("api")
@UseGuards(AuthGuard)
export class RelationController {
  constructor(private readonly relations: RelationService, private readonly pages: PageService) {}
  @Get("relations") list(@Req() r: AuthenticatedRequest, @Query("definitionId") id?: string) { return this.relations.list(r.actor, id); }
  @Post("relations") create(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.relations.save(r.actor, b); }
  @Put("relations/:id") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.relations.save(r.actor, b, id); }
  @Post("relations/:id/publish") publish(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.relations.publish(r.actor, id, b); }
  @Get("records/:recordId/relations") record(@Req() r: AuthenticatedRequest, @Param("recordId") recordId: string) { return this.relations.forRecord(r.actor, recordId); }
  @Get("records/:recordId/relations/:id/candidates") candidates(@Req() r: AuthenticatedRequest, @Param("recordId") recordId: string, @Param("id") id: string, @Query("rowId") rowId?: string, @Query("cursor") cursor?: string, @Query("q") q?: string) { return this.relations.candidates(r.actor, recordId, id, rowId, cursor, q); }
  @Post("records/:recordId/relations/:id/links") link(@Req() r: AuthenticatedRequest, @Param("recordId") recordId: string, @Param("id") id: string, @Body() b: unknown) { return this.relations.link(r.actor, recordId, id, b); }
  @Post("records/:recordId/relations/:id/links/:linkId/remove") unlink(@Req() r: AuthenticatedRequest, @Param("recordId") recordId: string, @Param("id") id: string, @Param("linkId") linkId: string, @Body() b: unknown) { return this.relations.unlink(r.actor, recordId, id, linkId, b); }
  @Get("pages/:pageId/records/:recordId/relations") async pageRelations(@Req() r: AuthenticatedRequest, @Param("pageId") pageId: string, @Param("recordId") recordId: string, @Query("version") version: string) {
    return this.relations.forRecord(r.actor, recordId, await this.pages.recordScope(r.actor, pageId, Number(version)));
  }
  @Get("pages/:pageId/records/:recordId/relations/:id/candidates") async pageCandidates(@Req() r: AuthenticatedRequest, @Param("pageId") pageId: string, @Param("recordId") recordId: string, @Param("id") id: string, @Query("version") version: string, @Query("rowId") rowId?: string, @Query("cursor") cursor?: string, @Query("q") q?: string) {
    return this.relations.candidates(r.actor, recordId, id, rowId, cursor, q, await this.pages.recordScope(r.actor, pageId, Number(version)));
  }
  @Post("pages/:pageId/records/:recordId/relations/:id/links") async pageLink(@Req() r: AuthenticatedRequest, @Param("pageId") pageId: string, @Param("recordId") recordId: string, @Param("id") id: string, @Body() b: any) {
    const scope = await this.pages.recordScope(r.actor, pageId, b?.pageVersion);
    return this.relations.link(r.actor, recordId, id, b, scope);
  }
  @Post("pages/:pageId/records/:recordId/relations/:id/links/:linkId/remove") async pageUnlink(@Req() r: AuthenticatedRequest, @Param("pageId") pageId: string, @Param("recordId") recordId: string, @Param("id") id: string, @Param("linkId") linkId: string, @Body() b: any) {
    const scope = await this.pages.recordScope(r.actor, pageId, b?.pageVersion);
    return this.relations.unlink(r.actor, recordId, id, linkId, b, scope);
  }
}
