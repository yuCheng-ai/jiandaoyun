import { Global, Module } from "@nestjs/common";
import { AuthService, AuthGuard } from "./auth.service";
import { SessionController } from "./session.controller";

@Global()
@Module({
  controllers: [SessionController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
