import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "../../core/auth/auth.service";
import { OrganizationService } from "./organization.service";
import { AccountService } from "./accounts.service";
import { DirectoryService } from "./directory.service";

@Controller("api/organization")
@UseGuards(AuthGuard)
export class OrganizationController {
  constructor(
    private readonly organizations: OrganizationService,
    private readonly accounts: AccountService,
    private readonly directory: DirectoryService,
  ) {}
  @Get() get(@Req() r: AuthenticatedRequest) { return this.organizations.get(r.actor); }
  @Get("directory") async directoryGet(@Req() r: AuthenticatedRequest) { return { directory: await this.directory.get(r.actor) }; }
  @Get("role-applications") roleApplications(@Req() r: AuthenticatedRequest) { return this.directory.applications(r.actor); }
  @Post("directory") directoryInitialize(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.directory.save(r.actor, b, true); }
  @Put("directory") directorySave(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.directory.save(r.actor, b); }
  @Put() save(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.organizations.save(r.actor, b); }
  @Post("accounts") createAccount(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.accounts.save(r.actor, b); }
  @Get("member-accounts") memberAccounts(@Req() r: AuthenticatedRequest, @Query("namespace") namespace: string) { return this.accounts.memberAccounts(r.actor, namespace); }
  @Put("member-accounts") associateMember(@Req() r: AuthenticatedRequest, @Body() b: unknown) { return this.accounts.associateMember(r.actor, b); }
  @Put("accounts/:id") updateAccount(@Req() r: AuthenticatedRequest, @Param("id") id: string, @Body() b: unknown) { return this.accounts.save(r.actor, b, id, r.headers.cookie); }
}
