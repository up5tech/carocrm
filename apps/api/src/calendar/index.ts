/**
 * Calendar module barrel (PLAN §27) — integrator entry point.
 *
 * Wire into AppModule:
 *   controllers: [...CALENDAR_CONTROLLERS]   // static prefix, must precede ENTITY_CONTROLLERS
 *   providers:   [...CALENDAR_PROVIDERS]
 *
 * `CalendarService` reads through `EntityCrudService`, so record-level ACL and field
 * restrictions are inherited from the generic entity layer rather than re-implemented.
 */
import type { Provider, Type } from '@nestjs/common';

import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';

export { CalendarController } from './calendar.controller.js';
export type { CalendarEventDto, CalendarQuery } from './calendar.service.js';
export { CalendarService, dayKeyInZone,DEFAULT_CALENDAR_ENTITIES } from './calendar.service.js';
export type { Occurrence, RecurrenceConfig,RepeatByMonth, RepeatType } from './recurrence.js';
export { expandOccurrences, MAX_OCCURRENCES } from './recurrence.js';

export const CALENDAR_PROVIDERS: Provider[] = [CalendarService];

export const CALENDAR_CONTROLLERS: Type<unknown>[] = [CalendarController];
