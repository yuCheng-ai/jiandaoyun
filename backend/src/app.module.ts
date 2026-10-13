import { Module } from "@nestjs/common";
import { DatabaseModule } from "./core/database/database.module";
import { AuthModule } from "./core/auth/auth.module";
import { DirectoryModule } from "./modules/directory/directory.module";
import { AccessModule } from "./modules/access/access.module";
import { ApplicationsModule } from "./modules/applications/applications.module";
import { RecordsModule } from "./modules/records/records.module";
import { PagesModule } from "./modules/pages/pages.module";
import { ProcessesModule } from "./modules/processes/processes.module";
import { RelationsModule } from "./modules/relations/relations.module";

/** 服务端根模块：聚合基础设施模块与各业务域模块 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    DirectoryModule,
    AccessModule,
    ApplicationsModule,
    RecordsModule,
    PagesModule,
    ProcessesModule,
    RelationsModule,
  ],
})
export class AppModule {}
