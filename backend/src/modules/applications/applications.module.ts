import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationService } from "./applications.service";

/** 应用管理模块 */
@Module({
  imports: [AccessModule],
  controllers: [ApplicationsController],
  providers: [ApplicationService],
  exports: [ApplicationService],
})
export class ApplicationsModule {}
