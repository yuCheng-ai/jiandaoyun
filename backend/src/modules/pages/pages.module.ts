import { Module } from "@nestjs/common";
import { DirectoryModule } from "../directory/directory.module";
import { AccessModule } from "../access/access.module";
import { RecordsModule } from "../records/records.module";
import { PageController, PlatformController } from "./pages.controller";
import { PageService } from "./pages.service";
import { PlatformService } from "./platform.service";
import { RecordEvolutionService } from "./record-evolution.service";

@Module({
  imports: [DirectoryModule, AccessModule, RecordsModule],
  controllers: [PlatformController, PageController],
  providers: [PlatformService, PageService, RecordEvolutionService],
  exports: [PlatformService, PageService, RecordEvolutionService],
})
export class PagesModule {}
