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

/**
 * 历史数据与应用迁移模块：
 * 负责身份映射核对、组织关系对齐、应用表单与权限快照检查、应用全量导入以及记录来源档案查询。
 */
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
