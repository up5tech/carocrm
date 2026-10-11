import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IdentityService } from './identity.service.js';

@ApiTags('identity')
@Controller('api/v1')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get('User')
  listUsers(@Query('offset') offset?: string, @Query('maxSize') maxSize?: string, @Query('where') where?: string) {
    return this.identity.listUsers(Number(offset ?? 0), Number(maxSize ?? 20), where);
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

  @Get('Role')
  listRoles(@Query('offset') offset?: string, @Query('maxSize') maxSize?: string) {
    return this.identity.listRoles(Number(offset ?? 0), Number(maxSize ?? 20));
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

  @Post('ApiUser')
  createApiUser(@Body() body: { userName: string; assignedRoleIds?: string[] }) {
    return this.identity.createApiUser(body);
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
}
