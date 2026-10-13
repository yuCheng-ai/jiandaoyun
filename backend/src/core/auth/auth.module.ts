import { Global, Module } from "@nestjs/common";
import { AuthService, AuthGuard } from "./auth.service";
import { SessionController } from "./session.controller";

/** 全局认证与会话管理模块 */
@Global()
@Module({
  controllers: [SessionController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
