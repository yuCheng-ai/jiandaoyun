import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { DirectoryModule } from "../directory/directory.module";
import { RecordsModule } from "../records/records.module";
import { ModelService } from "./models.service";
import { PageController } from "./pages.controller";
import { PageService } from "./pages.service";

/** 页面设计与发布编排；记录执行由 RecordsModule 提供。 */
@Module({
  imports: [DirectoryModule, AccessModule, RecordsModule],
  controllers: [PageController],
  providers: [PageService, ModelService],
  exports: [PageService],
})
export class PagesModule {}
