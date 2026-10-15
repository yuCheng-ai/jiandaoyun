import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { DirectoryModule } from "../directory/directory.module";
import { CollectionService } from "./collection.service";
import { FileService } from "./files.service";
import { RecordEvolutionService } from "./record-evolution.service";
import { RecordValuesService } from "./record-values.service";
import { RecordViewService } from "./record-views.service";
import { CollectionController, RecordController } from "./records.controller";
import { RecordService } from "./records.service";

/** 低代码记录执行模块：独立提供读写、字段值、附件、版本演进及收集规则。 */
@Module({
  imports: [DirectoryModule, AccessModule],
  controllers: [CollectionController, RecordController],
  providers: [
    RecordService,
    RecordValuesService,
    RecordEvolutionService,
    FileService,
    CollectionService,
    RecordViewService,
  ],
  exports: [
    RecordService,
    RecordValuesService,
    RecordEvolutionService,
    CollectionService,
    RecordViewService,
  ],
})
export class RecordsModule {}
