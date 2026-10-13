import { Global, Module } from "@nestjs/common";
import { Database } from "./database";

/** 全局数据库连接池与事务管理模块 */
@Global()
@Module({
  providers: [Database],
  exports: [Database],
})
export class DatabaseModule {}
