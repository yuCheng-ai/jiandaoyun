import { Module } from "@nestjs/common";
import { PagesModule } from "../pages/pages.module";
import { RelationController } from "./relations.controller";
import { RelationService } from "./relations.service";

/** 跨表单记录关联与数据回填模块 */
@Module({
  imports: [PagesModule],
  controllers: [RelationController],
  providers: [RelationService],
  exports: [RelationService],
})
export class RelationsModule {}
