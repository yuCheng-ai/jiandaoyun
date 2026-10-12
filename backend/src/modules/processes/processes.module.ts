import { Module } from "@nestjs/common";
import { DirectoryModule } from "../directory/directory.module";
import { PagesModule } from "../pages/pages.module";
import { ProcessesController } from "./processes.controller";
import { ProcessTemplateController } from "./process-templates.controller";
import { ProcessService } from "./processes.service";
import { ProcessTemplateService } from "./process-templates.service";
import { TaskContextService } from "./task-context.service";

@Module({
  imports: [DirectoryModule, PagesModule],
  controllers: [ProcessesController, ProcessTemplateController],
  providers: [ProcessService, ProcessTemplateService, TaskContextService],
  exports: [ProcessService, ProcessTemplateService, TaskContextService],
})
export class ProcessesModule {}
