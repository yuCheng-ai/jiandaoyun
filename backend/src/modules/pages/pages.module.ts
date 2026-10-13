import { Module } from "@nestjs/common";
import { DirectoryModule } from "../directory/directory.module";
import { AccessModule } from "../access/access.module";
import { RecordsModule } from "../records/records.module";
import { PageController, PlatformController } from "./pages.controller";
import { PageService } from "./pages.service";
import { PlatformService } from "./platform.service";
import { RecordEvolutionService } from "./record-evolution.service";

/** 页面与表单平台模块：提供数据模型、页面设计器、记录读写及版本演进能力 */
@Module({
  imports: [DirectoryModule, AccessModule, RecordsModule],
  controllers: [PlatformController, PageController],
  providers: [PlatformService, PageService, RecordEvolutionService],
  exports: [PlatformService, PageService, RecordEvolutionService],
})
export class PagesModule {}
