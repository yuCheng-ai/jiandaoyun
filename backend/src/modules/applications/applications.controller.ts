import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { ApplicationService } from "./applications.service";

@Controller("api/applications")
@UseGuards(AuthGuard)
export class ApplicationsController {
  constructor(private readonly applications: ApplicationService) {}
  @Get() list(@Req() r: AuthenticatedRequest) { return this.applications.list(r.actor); }
  @Post() create(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.applications.create(r.actor, b); }
}
