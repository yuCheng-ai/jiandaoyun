import { Module } from "@nestjs/common";
import { DirectoryModule } from "../directory/directory.module";
import { AccessModule } from "../access/access.module";
import { RecordsModule } from "../records/records.module";
import { PagesModule } from "../pages/pages.module";
import { MigrationIdentityController, RecordOriginController } from "./migrations.controller";
import { MigrationIdentityService } from "./migration-identities.service";
import { MigrationResourceService } from "./migration-resources.service";
import { MigrationOrganizationService } from "./migration-organization.service";
import { ApplicationImportService } from "./application-import.service";
import { RecordOriginService } from "./record-origins.service";

@Module({
  imports: [DirectoryModule, AccessModule, RecordsModule, PagesModule],
  controllers: [MigrationIdentityController, RecordOriginController],
  providers: [
    MigrationIdentityService,
    MigrationResourceService,
    MigrationOrganizationService,
    ApplicationImportService,
    RecordOriginService,
  ],
  exports: [
    MigrationIdentityService,
    MigrationResourceService,
    MigrationOrganizationService,
    ApplicationImportService,
    RecordOriginService,
  ],
})
export class MigrationsModule {}
