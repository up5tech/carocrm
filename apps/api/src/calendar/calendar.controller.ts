import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import type { CalendarEventDto } from './calendar.service.js';
import { CalendarService, DEFAULT_CALENDAR_ENTITIES } from './calendar.service.js';

const MAX_WINDOW_DAYS = 184;

const CalendarQuerySchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    timeZone: z.string().min(1).default('UTC'),
    userId: z.string().min(1).optional(),
    maxSize: z.coerce.number().int().min(1).max(1000).default(300),
    entities: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .refine((value) => !Number.isNaN(Date.parse(value.from)) && !Number.isNaN(Date.parse(value.to)), {
    message: '"from" and "to" must be ISO-8601 date times.',
  })
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), { message: '"to" must be after "from".' })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= MAX_WINDOW_DAYS, {
    message: `The requested window may not exceed ${MAX_WINDOW_DAYS} days.`,
  });

function entityList(value: string | string[] | undefined): string[] {
  const raw = (Array.isArray(value) ? value : value?.split(',') ?? [])
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return raw.length > 0 ? [...new Set(raw)] : [...DEFAULT_CALENDAR_ENTITIES];
}

@ApiTags('calendar')
@Controller('api/v1/Calendar')
export class CalendarController {
  constructor(@Inject(CalendarService) private readonly calendar: CalendarService) {}

  /**
   * Occurrences of calendar activities inside a window. EspoCRM has no documented
   * calendar endpoint, so this contract is ours (see docs/reference/compatibility-matrix.md).
   */
  @Get()
  async list(@Query() query: unknown): Promise<{
    list: CalendarEventDto[];
    from: string;
    to: string;
    timeZone: string;
    count: number;
  }> {
    const parsed = CalendarQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new InvalidQueryError('Invalid calendar query.', {
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    const { from, to, timeZone, userId, maxSize, entities } = parsed.data;
    try {
      Intl.DateTimeFormat(undefined, { timeZone });
    } catch {
      throw new InvalidQueryError('Unknown time zone.', { timeZone });
    }
    const list = await this.calendar.query({
      from: new Date(from),
      to: new Date(to),
      timeZone,
      entities: entityList(entities),
      maxSize,
      ...(userId !== undefined ? { userId } : {}),
    });
    return { list, from: new Date(from).toISOString(), to: new Date(to).toISOString(), timeZone, count: list.length };
  }
}
