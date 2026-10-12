import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationService } from "./applications.service";

@Module({
  imports: [AccessModule],
  controllers: [ApplicationsController],
  providers: [ApplicationService],
  exports: [ApplicationService],
})
export class ApplicationsModule {}
