import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { IdentityService, USER_ACCOUNT_TYPES, type UserAccountType, type UserFilters } from './identity.service.js';

@ApiTags('identity')
@Controller('api/v1')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get('User')
  listUsers(
    @Query('offset') offset?: string,
    @Query('maxSize') maxSize?: string,
    @Query('where') where?: string,
    @Query('isActive') isActive?: string,
    @Query('type') type?: string,
    @Query('roleId') roleId?: string,
    @Query('teamId') teamId?: string,
  ) {
    return this.identity.listUsers(Number(offset ?? 0), Number(maxSize ?? 20), where, userFilters({ isActive, type, roleId, teamId }));
  }

  /**
   * The assignee picker (PLAN_Phase_20_Settings_UX.md §5.3). Declared before `User/:id` so the
   * literal segment wins over the wildcard, and deliberately narrower than `GET /User`.
   */
  @Get('User/assignable')
  listAssignableUsers(@Query('q') q?: string) {
    return this.identity.listAssignableUsers(q);
  }

  @Get('User/:id')
  getUser(@Param('id') id: string) {
    return this.identity.getUser(id);
  }

  @Post('User')
  createUser(@Body() body: unknown) {
    return this.identity.createUser(body);
  }

  @Patch('User/:id')
  @Put('User/:id')
  updateUser(@Param('id') id: string, @Body() body: unknown) {
    return this.identity.updateUser(id, body);
  }

  @Delete('User/:id')
  deleteUser(@Param('id') id: string) {
    return this.identity.deleteUser(id);
  }

  /** An administrator setting a password is a reset: the sessions the old one opened are revoked. */
  @HttpCode(200)
  @Post('User/:id/password-reset')
  resetPassword(@Param('id') id: string, @Body() body: unknown) {
    const parsed = ResetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidQueryError('A new password of at least 8 characters is required.', {
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    return this.identity.resetUserPassword(id, parsed.data.password);
  }

  @Get('Role')
  listRoles(@Query('offset') offset?: string, @Query('maxSize') maxSize?: string, @Query('q') q?: string) {
    return this.identity.listRoles(Number(offset ?? 0), Number(maxSize ?? 20), q ?? '');
  }

  @Get('Role/:id')
  getRole(@Param('id') id: string) {
    return this.identity.getRole(id);
  }

  @Post('Role')
  createRole(@Body() body: unknown) {
    return this.identity.createRole(body);
  }

  @Patch('Role/:id')
  @Put('Role/:id')
  updateRole(@Param('id') id: string, @Body() body: unknown) {
    return this.identity.updateRole(id, body);
  }

  @Delete('Role/:id')
  deleteRole(@Param('id') id: string) {
    return this.identity.deleteRole(id);
  }

  @Get('ApiUser')
  listApiUsers() {
    return this.identity.listApiUsers();
  }

  @Post('ApiUser')
  createApiUser(@Body() body: { userName: string; assignedRoleIds?: string[] }) {
    return this.identity.createApiUser(body);
  }

  /** Issue an additional key. The secret appears in this response only; a rotation is a new key plus a revoke. */
  @HttpCode(201)
  @Post('ApiUser/:apiUserId/key')
  issueApiKey(@Param('apiUserId') apiUserId: string) {
    return this.identity.issueApiKey(apiUserId);
  }

  @Get('ApiKey/:apiUserId')
  listApiKeys(@Param('apiUserId') apiUserId: string) {
    return this.identity.listApiKeys(apiUserId);
  }

  @Delete('ApiKey/:keyId')
  revokeApiKey(@Param('keyId') keyId: string) {
    return this.identity.revokeApiKey(keyId);
  }

  @Get('Team')
  listTeams(@Query('offset') offset?: string, @Query('maxSize') maxSize?: string) {
    return this.identity.listTeams(Number(offset ?? 0), Number(maxSize ?? 20));
  }

  @Get('Team/:id')
  getTeam(@Param('id') id: string) {
    return this.identity.getTeam(id);
  }

  @Post('Team')
  createTeam(@Body() body: unknown) {
    return this.identity.createTeam(body);
  }

  @Patch('Team/:id')
  @Put('Team/:id')
  updateTeam(@Param('id') id: string, @Body() body: unknown) {
    return this.identity.updateTeam(id, body);
  }

  @Delete('Team/:id')
  deleteTeam(@Param('id') id: string) {
    return this.identity.deleteTeam(id);
  }
}

const ResetPasswordSchema = z.object({ password: z.string().min(8).max(512) });

/**
 * The boolean and enum filters are validated rather than guessed: a misspelt value would otherwise
 * quietly widen the list an administrator is looking at.
 */
function userFilters(input: {
  isActive?: string | undefined;
  type?: string | undefined;
  roleId?: string | undefined;
  teamId?: string | undefined;
}): UserFilters {
  const filters: { isActive?: boolean; type?: UserAccountType; roleId?: string; teamId?: string } = {};
  if (input.isActive === 'true' || input.isActive === 'false') filters.isActive = input.isActive === 'true';
  else if (input.isActive !== undefined) throw new InvalidQueryError('isActive must be true or false.', { isActive: input.isActive });
  if (input.type !== undefined) {
    const matched = USER_ACCOUNT_TYPES.find((candidate) => candidate === input.type);
    if (matched === undefined) throw new InvalidQueryError('Unknown account type.', { type: input.type, allowed: USER_ACCOUNT_TYPES });
    filters.type = matched;
  }
  if (input.roleId !== undefined && input.roleId !== '') filters.roleId = input.roleId;
  if (input.teamId !== undefined && input.teamId !== '') filters.teamId = input.teamId;
  return filters;
}
