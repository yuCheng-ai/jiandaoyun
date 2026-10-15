import { Module } from "@nestjs/common";
import { DirectoryModule } from "../directory/directory.module";
import { GroupConfigurationController, OrganizationPermissionsController } from "./access.controller";
import { AccessService, RecordAccessGuard } from "./access.service";
import { GroupConfigurationService } from "./group-config.service";

/** 表单与记录访问权限模块（含常规授权策略与权限组配置） */
@Module({
  imports: [DirectoryModule],
  controllers: [GroupConfigurationController, OrganizationPermissionsController],
  providers: [AccessService, GroupConfigurationService, RecordAccessGuard],
  exports: [AccessService, GroupConfigurationService, RecordAccessGuard],
})
export class AccessModule {}
