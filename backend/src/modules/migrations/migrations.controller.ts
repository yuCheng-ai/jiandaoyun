import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { MigrationIdentityService } from "./migration-identities.service";
import { MigrationResourceService } from "./migration-resources.service";
import { MigrationOrganizationService } from "./migration-organization.service";
import { ApplicationImportService } from "./application-import.service";
import { RecordOriginService } from "./record-origins.service";

@Controller("api/migration-batches")
@UseGuards(AuthGuard)
export class MigrationIdentityController {
  constructor(
    private readonly migrations: MigrationIdentityService,
    private readonly resources: MigrationResourceService,
    private readonly organizationImport: MigrationOrganizationService,
    private readonly applicationImport: ApplicationImportService,
  ) {}
  @Get() list(@Req() r: AuthenticatedRequest, @Query("namespace") namespace: string, @Query("applicationId") applicationId?: string) { return this.migrations.list(r.actor, namespace, applicationId); }
  @Post() create(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.migrations.create(r.actor, b); }
  @Get(":id") get(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.migrations.get(r.actor, id); }
  @Get(":id/events") events(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.migrations.events(r.actor, id); }
  @Post(":id/organization-preview") organizationPreview(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.organizationImport.review(r.actor, id, b); }
  @Post(":id/organization-import") importOrganization(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.organizationImport.apply(r.actor, id, b); }
  @Get(":id/resources") resourcesGet(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.resources.get(r.actor, id); }
  @Post(":id/resources") resourcesPrepare(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.resources.prepare(r.actor, id, b); }
  @Post(":id/application-import") importApplication(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.applicationImport.apply(r.actor, id, b); }
  @Put(":id") save(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.save(r.actor, id, b); }
  @Post(":id/source") source(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.save(r.actor, id, b, true); }
  @Post(":id/review") review(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.review(r.actor, id, b); }
  @Post(":id/confirm-identities") confirm(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.confirm(r.actor, id, b); }
  @Post(":id/reopen") reopen(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.migrations.confirm(r.actor, id, b, true); }
}

@Controller("api/records")
@UseGuards(AuthGuard)
export class RecordOriginController {
  constructor(private readonly origins: RecordOriginService) {}
  @Get(":id/origin") get(@Req() r: AuthenticatedRequest, @Param("id") id: string) { return this.origins.get(r.actor, id); }
}
