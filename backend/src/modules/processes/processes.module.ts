import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { DirectoryModule } from "../directory/directory.module";
import { PagesModule } from "../pages/pages.module";
import { RecordsModule } from "../records/records.module";
import {
  FormSubmissionController,
  ProcessTemplateController,
} from "./process-templates.controller";
import { ProcessTemplateService } from "./process-templates.service";
import { ProcessesController } from "./processes.controller";
import { ProcessService } from "./processes.service";
import { TaskContextService } from "./task-context.service";


/** 流程引擎模块：承载任务模板管理、流程实例调度与任务上下文读写 */
@Module({
  imports: [RecordsModule, AccessModule, DirectoryModule, PagesModule],
  controllers: [ProcessesController, ProcessTemplateController, FormSubmissionController],
  providers: [ProcessService, ProcessTemplateService, TaskContextService],
  exports: [ProcessService, ProcessTemplateService, TaskContextService],
})
export class ProcessesModule {}
