import { Module } from "@nestjs/common";
import { DirectoryModule } from "../directory/directory.module";
import { GroupConfigurationController } from "./access.controller";
import { AccessService } from "./access.service";
import { GroupConfigurationService } from "./group-config.service";

@Module({
  imports: [DirectoryModule],
  controllers: [GroupConfigurationController],
  providers: [AccessService, GroupConfigurationService],
  exports: [AccessService, GroupConfigurationService],
})
export class AccessModule {}
