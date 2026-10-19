import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PreferencesService, type PreferenceView } from './preferences.service.js';

/**
 * Per-user preferences (PLAN_Phase_20_Settings_UX.md §20.10). The routes carry no user id on purpose:
 * the caller's own row is the only one reachable, so the enforcement is the shape of the API rather
 * than a check that could be forgotten. Unauthenticated requests are refused by the global guard.
 */
@ApiTags('preferences')
@Controller('api/v1/Preferences')
export class PreferencesController {
  constructor(@Inject(PreferencesService) private readonly preferences: PreferencesService) {}

  @Get()
  all(): Promise<{ items: PreferenceView[] }> {
    return this.preferences.all();
  }

  @Get(':name')
  get(@Param('name') name: string): Promise<PreferenceView> {
    return this.preferences.get(name);
  }

  @Put(':name')
  put(@Param('name') name: string, @Body() body: unknown): Promise<PreferenceView> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object with a "value".', { name });
    }
    return this.preferences.put(name, (body as Record<string, unknown>)['value']);
  }
}
