import { Module } from "@nestjs/common";
import { DirectoryModule } from "../directory/directory.module";
import { AccessModule } from "../access/access.module";
import { CollectionController } from "./records.controller";
import { CollectionService } from "./collection.service";
import { RecordViewService } from "./record-views.service";

/** 记录管理辅助模块：承载表单收集规则控制与记录列表视图配置 */
@Module({
  imports: [DirectoryModule, AccessModule],
  controllers: [CollectionController],
  providers: [CollectionService, RecordViewService],
  exports: [CollectionService, RecordViewService],
})
export class RecordsModule {}
