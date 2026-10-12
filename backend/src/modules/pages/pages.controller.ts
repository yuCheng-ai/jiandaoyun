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
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { PlatformService } from "./platform.service";
import { PageService } from "./pages.service";

@Controller("api")
@UseGuards(AuthGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}
  @Post("definitions/:id/organization-options") organizationOptions(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.organizationOptions(r.actor, id, b); }
  @Get("users") users(@Req() r: AuthenticatedRequest) { return this.platform.users(r.actor); }
  @Get("records/:id/removed-rows") removedRows(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.platform.removedRows(r.actor, id); }
  @Get("definitions") definitions(@Req() r: AuthenticatedRequest) { return this.platform.definitions(r.actor); }
  @Post("definitions/:id/publish-preview") definitionImpact(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.modelImpact(r.actor, id, b, true); }
  @Post("definitions") create(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.platform.saveDefinition(r.actor, b); }
  @Put("definitions/:id") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.saveDefinition(r.actor, b, id); }
  @Post("definitions/:id/publish") publish(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.publish(r.actor, id, b); }
  @Get("definitions/:id") published(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.platform.published(r.actor, id); }
  @Get("definitions/:id/grants") grants(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.platform.grants(r.actor, id); }
  @Get("definitions/:id/subject-grants") subjectGrants(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.platform.subjectGrants(r.actor, id); }
  @Put("definitions/:id/subject-grants") subjectGrant(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.grant(r.actor, id, b, true); }
  @Put("definitions/:id/grants") grant(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.grant(r.actor, id, b); }
  @Get("definitions/:id/records") records(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Query("state") state?: string) { return this.platform.records(r.actor, id, state); }
  @Post("definitions/:id/records") add(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.createRecord(r.actor, id, b); }
  @Get("records/:id") detail(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.platform.detail(r.actor, id); }
  @Patch("records/:id") patch(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.patchRecord(r.actor, id, b); }
  @Post("records/:id/submit") submitRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.submitRecord(r.actor, id, b); }
  @Get("records/:id/output/:action") output(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("action") action: string) { return this.platform.output(r.actor, id, action); }
  @Get("records/:id/events") events(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.platform.events(r.actor, id); }
  @Post("records/:id/archive") archive(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.archiveRecord(r.actor, id, b); }
}

@Controller("api")
@UseGuards(AuthGuard)
export class PageController {
  constructor(private readonly pages: PageService, private readonly platform: PlatformService) {}
  @Get("data-objects") objects(@Req() r: AuthenticatedRequest, @Query("applicationId") appId?: string) { return this.platform.definitions(r.actor, appId); }
  @Get("data-objects/:id/draft") object(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.pages.objectDraft(r.actor, id); }
  @Get("data-objects/:id/pending-page-fields") pendingFields(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.pages.pendingFields(r.actor, id); }
  @Get("data-objects/:id/published-model") latestModel(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.pages.latestModel(r.actor, id); }
  @Post("data-objects") createObject(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.pages.saveObject(r.actor, b); }
  @Put("data-objects/:id") saveObject(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.saveObject(r.actor, b, id); }
  @Post("data-objects/:id/publish") publishObject(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.publishObject(r.actor, id, b); }
  @Post("data-objects/:id/publish-preview") objectImpact(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.modelImpact(r.actor, id, b); }
  @Post("data-objects/:id/discard-draft") discardObject(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.discardObjectDraft(r.actor, id, b); }
  @Get("data-objects/:id/versions/:version") model(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("version") version: string) { return this.pages.publishedModel(r.actor, id, Number(version)); }
  @Get("pages") list(@Req() r: AuthenticatedRequest, @Query("definitionId") id?: string, @Query("applicationId") appId?: string, @Query("state") state?: string) { return this.pages.list(r.actor, id, appId, state); }
  @Post("pages/new-business") newBusiness(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.pages.createWithObject(r.actor, b); }
  @Get("pages/:id/editor") editor(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.pages.editor(r.actor, id); }
  @Post("pages/:id/organization-options") organizationOptions(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.organizationOptions(r.actor, id, b); }
  @Get("pages/:id/form") form(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Query("version") version?: string) { return this.pages.form(r.actor, id, version ? Number(version) : undefined); }
  @Get("pages/:id/draft") draft(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.pages.draft(r.actor, id); }
  @Get("pages/:id") published(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Query("version") version?: string) { return this.pages.published(r.actor, id, version ? Number(version) : undefined); }
  @Post("pages") create(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.pages.save(r.actor, b); }
  @Put("pages/:id") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.save(r.actor, b, id); }
  @Post("pages/:id/publish") publish(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.publish(r.actor, id, b); }
  @Post("pages/:id/publish-preview") publishPreview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.publishPreview(r.actor, id, b); }
  @Post("pages/:id/lifecycle-preview") lifecyclePreview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.lifecyclePreview(r.actor, id, b); }
  @Post("pages/:id/archive") archivePage(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.lifecycle(r.actor, id, b, "archive"); }
  @Post("pages/:id/restore") restorePage(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.lifecycle(r.actor, id, b, "restore"); }
  @Post("pages/:id/discard-draft") discardPage(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.discardDraft(r.actor, id, b); }
  @Get("pages/:id/record-list") recordList(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Query("version") version?: string, @Query("state") state?: string, @Query("page") page?: string) { return this.pages.recordList(r.actor, id, version ? Number(version) : undefined, state, page === undefined ? 1 : Number(page)); }
  @Get("pages/:id/records") records(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Query("version") version?: string, @Query("state") state?: string) { return this.pages.records(r.actor, id, version ? Number(version) : undefined, state); }
  @Get("pages/:id/records/:recordId") record(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Query("version") version?: string) { return this.pages.record(r.actor, id, recordId, version ? Number(version) : undefined); }
  @Get("pages/:id/records/:recordId/removed-rows") removedPageRows(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Query("version") version?: string) { return this.pages.removedRows(r.actor, id, recordId, version ? Number(version) : undefined); }
  @Get("pages/:id/records/:recordId/upgrade") upgradePreview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Query("version") version?: string) { return this.pages.recordUpgrade(r.actor, id, recordId, { pageVersion: version ? Number(version) : undefined }, true); }
  @Post("pages/:id/records/:recordId/upgrade") upgradeRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Body() b: unknown) { return this.pages.recordUpgrade(r.actor, id, recordId, b); }
  @Post("pages/:id/records/:recordId/submit") submitPageRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") rid: string, @Body() b: unknown) { return this.pages.submitRecord(r.actor, id, rid, b); }
  @Post("pages/:id/records") createRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.writeRecord(r.actor, id, b); }
  @Patch("pages/:id/records/:recordId") patchRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Body() b: unknown) { return this.pages.writeRecord(r.actor, id, b, recordId); }
}
