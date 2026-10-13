import { Module } from "@nestjs/common";
import { DirectoryModule } from "../directory/directory.module";
import { PagesModule } from "../pages/pages.module";
import { ProcessesController } from "./processes.controller";
import { ProcessTemplateController, FormSubmissionController } from "./process-templates.controller";
import { ProcessService } from "./processes.service";
import { ProcessTemplateService } from "./process-templates.service";
import { TaskContextService } from "./task-context.service";

/** 流程引擎模块：承载任务模板管理、流程实例调度与任务上下文读写 */
@Module({
  imports: [DirectoryModule, PagesModule],
  controllers: [ProcessesController, ProcessTemplateController, FormSubmissionController],
  providers: [ProcessService, ProcessTemplateService, TaskContextService],
  exports: [ProcessService, ProcessTemplateService, TaskContextService],
})
export class ProcessesModule {}
