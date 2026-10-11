import { GroupConfigurationService } from "./group-config";
import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { json } from "express";
import { AuthGuard, AuthService, AuthenticatedRequest } from "./auth";
import { config } from "./config";
import { Database } from "./database";
import { PlatformService } from "./platform";
import { ProcessService } from "./processes";
import { ProcessTemplateService } from "./process-templates";
import { RelationService } from "./relations";
import { TaskContextService } from "./task-context";
import { upgradeDataProjection } from "./data-projection";
import { PageService } from "./pages";
import { ApplicationService } from "./applications";
import { RecordEvolutionService } from "./record-evolution";
import { OrganizationService } from "./organization";
import { AccessService } from "./access";
import { MigrationIdentityService } from "./migration-identities";
import { MigrationResourceService } from "./migration-resources";
import { RecordOriginService } from "./record-origins";
import { CollectionService } from "./collection";

@Controller("api/definitions")
@UseGuards(AuthGuard)
class CollectionController {
  constructor(private readonly collection: CollectionService) {}
  @Get(":id/collection-rules") get(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.collection.get(r.actor, id); }
  @Put(":id/collection-rules") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.collection.save(r.actor, id, b); }
  @Get(":id/collection-rules/events") events(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.collection.events(r.actor, id); }
  @Get(":id/collection-status") status(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.collection.status(r.actor, id); }
}

@Controller("api/records")
@UseGuards(AuthGuard)
class RecordOriginController {
  constructor(private readonly origins: RecordOriginService) {}
  @Get(":id/origin") get(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.origins.get(r.actor, id); }
}

@Controller("api/migration-batches")
@UseGuards(AuthGuard)
class MigrationIdentityController {
  constructor(private readonly migrations: MigrationIdentityService, private readonly resources: MigrationResourceService) {}
  @Get() list(@Req() r: AuthenticatedRequest, @Query("namespace") namespace: string, @Query("applicationId") applicationId?: string) { return this.migrations.list(r.actor, namespace, applicationId); }
  @Post() create(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.migrations.create(r.actor, b); }
  @Get(":id") get(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.migrations.get(r.actor, id); }
  @Get(":id/events") events(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.migrations.events(r.actor, id); }
  @Get(":id/resources") resourcesGet(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.resources.get(r.actor, id); }
  @Post(":id/resources") resourcesPrepare(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.resources.prepare(r.actor, id, b); }
  @Put(":id") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.save(r.actor, id, b); }
  @Post(":id/source") source(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.save(r.actor, id, b, true); }
  @Post(":id/review") review(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.review(r.actor, id, b); }
  @Post(":id/confirm-identities") confirm(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.confirm(r.actor, id, b); }
  @Post(":id/reopen") reopen(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.confirm(r.actor, id, b, true); }
}

@Controller("api/organization")
@UseGuards(AuthGuard)
class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}
  @Get() get(@Req() r: AuthenticatedRequest) { return this.organizations.get(r.actor); }
  @Put() save(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.organizations.save(r.actor, b); }
}

@Controller("api")
class SessionController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Database,
  ) {}
  @Get("health") async health() {
    await this.db.query("SELECT 1");
    return { status: "ok", mode: "local-development" };
  }
  @Post("auth/login") async login(
    @Body() body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.auth.login(
      body?.username,
      body?.password,
      req.ip || "local",
    );
    res.cookie("platform_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookie,
      path: "/api",
      maxAge: 8 * 3600 * 1000,
    });
    return user;
  }
  @Get("auth/me") @UseGuards(AuthGuard) me(@Req() req: AuthenticatedRequest) {
    return req.actor;
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req.headers.cookie);
    res.clearCookie("platform_session", { path: "/api" });
    return { ok: true };
  }
}
@Controller("api")
@UseGuards(AuthGuard)
class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly processes: ProcessService,
  ) {}
  @Post("definitions/:id/organization-options") organizationOptions(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.organizationOptions(r.actor, id, b); }
  @Post("processes/:id/tasks/:taskId/organization-options") taskOrganizationOptions(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("taskId") tid: string, @Body() b: unknown) { return this.processes.taskOrganizationOptions(r.actor, id, tid, b); }
  @Get("users") users(@Req() r: AuthenticatedRequest) {
    return this.platform.users(r.actor);
  }
  @Get("records/:id/removed-rows") removedRows(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.platform.removedRows(r.actor, id); }
  @Get("definitions") definitions(@Req() r: AuthenticatedRequest) {
    return this.platform.definitions(r.actor);
  }
  @Post("definitions/:id/publish-preview") definitionImpact(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.modelImpact(r.actor, id, b, true); }
  @Post("definitions") create(
    @Req() r: AuthenticatedRequest,
    @Body() b: unknown,
  ) {
    return this.platform.saveDefinition(r.actor, b);
  }
  @Put("definitions/:id") save(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.platform.saveDefinition(r.actor, b, id);
  }
  @Post("definitions/:id/publish") publish(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.platform.publish(r.actor, id, b);
  }
  @Get("definitions/:id") published(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.platform.published(r.actor, id);
  }
  @Get("definitions/:id/grants") grants(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.platform.grants(r.actor, id);
  }
  @Get("definitions/:id/subject-grants") subjectGrants(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.platform.subjectGrants(r.actor, id); }
  @Put("definitions/:id/subject-grants") subjectGrant(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.grant(r.actor, id, b, true); }
  @Put("definitions/:id/grants") grant(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.platform.grant(r.actor, id, b);
  }
  @Get("definitions/:id/records") records(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("state") state?: string,
  ) {
    return this.platform.records(r.actor, id, state);
  }
  @Post("definitions/:id/records") add(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.platform.createRecord(r.actor, id, b);
  }
  @Get("records/:id") detail(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.platform.detail(r.actor, id);
  }
  @Patch("records/:id") patch(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.platform.patchRecord(r.actor, id, b);
  }
  @Post("records/:id/submit") submitRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.submitRecord(r.actor, id, b); }
  @Get("records/:id/output/:action") output(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("action") action: string) { return this.platform.output(r.actor, id, action); }
  @Get("records/:id/events") events(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.platform.events(r.actor, id);
  }
  @Post("records/:id/archive") archive(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.platform.archiveRecord(r.actor, id, b); }
  @Post("processes") process(
    @Req() r: AuthenticatedRequest,
    @Body() b: unknown,
  ) {
    return this.processes.create(r.actor, b);
  }
  @Get("processes") processesList(@Req() r: AuthenticatedRequest, @Query("applicationId") applicationId?: string) {
    return this.processes.list(r.actor, applicationId);
  }
  @Get("processes/:id") processGet(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.processes.get(r.actor, id);
  }
  @Post("processes/:id/tasks/:taskId/complete") complete(
    @Req() r: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("taskId") tid: string,
  ) {
    return this.processes.get(r.actor, id, tid);
  }
  @Get("processes/:id/tasks/:taskId/record") taskRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("taskId") tid: string) { return this.processes.taskRecord(r.actor, id, tid); }
  @Patch("processes/:id/tasks/:taskId/record") taskWrite(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("taskId") tid: string, @Body() b: unknown) { return this.processes.taskRecord(r.actor, id, tid, b); }
}
@Controller("api")
@UseGuards(AuthGuard)
class RelationController {
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
@Controller("api")
@UseGuards(AuthGuard)
class PageController {
  constructor(private readonly pages: PageService, private readonly platform: PlatformService, private readonly applications: ApplicationService) {}
  @Get("applications") applicationsList(@Req() r: AuthenticatedRequest) { return this.applications.list(r.actor); }
  @Post("applications") createApplication(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.applications.create(r.actor, b); }
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
  @Get("pages/:id/records/:recordId") record(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Query("version") version?: string) { return this.pages.record(r.actor, id, recordId, version ? Number(version) : undefined); }
  @Get("pages/:id/records/:recordId/removed-rows") removedPageRows(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Query("version") version?: string) { return this.pages.removedRows(r.actor, id, recordId, version ? Number(version) : undefined); }
  @Get("pages/:id/records/:recordId/upgrade") upgradePreview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Query("version") version?: string) { return this.pages.recordUpgrade(r.actor, id, recordId, { pageVersion: version ? Number(version) : undefined }, true); }
  @Post("pages/:id/records/:recordId/upgrade") upgradeRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Body() b: unknown) { return this.pages.recordUpgrade(r.actor, id, recordId, b); }
  @Post("pages/:id/records/:recordId/submit") submitPageRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") rid: string, @Body() b: unknown) { return this.pages.submitRecord(r.actor, id, rid, b); }
  @Post("pages/:id/records") createRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.pages.writeRecord(r.actor, id, b); }
  @Patch("pages/:id/records/:recordId") patchRecord(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Param("recordId") recordId: string, @Body() b: unknown) { return this.pages.writeRecord(r.actor, id, b, recordId); }
}
@Controller("api/process-templates")
@UseGuards(AuthGuard)
class ProcessTemplateController {
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
@Controller('api/definitions')
@UseGuards(AuthGuard)
class GroupConfigurationController {
  constructor(private readonly groups: GroupConfigurationService) {}
  @Get(':id/permission-groups') get(@Req() r: AuthenticatedRequest, @Param('id') id: string) { return this.groups.get(r.actor, id); }
  @Put(':id/permission-groups') save(@Req() r: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) { return this.groups.save(r.actor, id, body); }
  @Get(':id/permission-groups/options') options(@Req() r: AuthenticatedRequest, @Param('id') id: string) { return this.groups.options(r.actor, id); }
}
@Module({
  controllers: [CollectionController, GroupConfigurationController, SessionController, PlatformController, RelationController, PageController, ProcessTemplateController, OrganizationController, MigrationIdentityController, RecordOriginController],
  providers: [
    Database,
    OrganizationService,
    MigrationIdentityService,
    MigrationResourceService,
    RecordOriginService,
    AccessService,
    CollectionService,
    GroupConfigurationService,
    AuthService,
    AuthGuard,
    PlatformService,
    ProcessService,
    ProcessTemplateService,
    TaskContextService,
    RelationService,
    PageService,
    ApplicationService,
    RecordEvolutionService,
  ],
})
class AppModule {}

export async function createApp() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      return res.status(403).json({ message: "请求来源不合法" });
    next();
  });
  app.use("/api/migration-batches", json({ limit: "16mb" }));
  app.use(json({ limit: "1mb" }));
  try {
    await app.get(Database).migrate();
    await upgradeDataProjection(app.get(Database));
    await app.get(AuthService).seed();
    await app.get(ApplicationService).seed();
    app.enableShutdownHooks();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
