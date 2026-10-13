import { Module } from "@nestjs/common";
import { OrganizationController } from "./directory.controller";
import { OrganizationService } from "./organization.service";
import { AccountService } from "./accounts.service";
import { DirectoryService } from "./directory.service";

/** 组织架构、通讯录同步与登录账号管理模块 */
@Module({
  controllers: [OrganizationController],
  providers: [OrganizationService, AccountService, DirectoryService],
  exports: [OrganizationService, AccountService, DirectoryService],
})
export class DirectoryModule {}
