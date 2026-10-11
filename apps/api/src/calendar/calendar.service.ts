import { Inject, Injectable } from '@nestjs/common';

import { EntityCrudService } from '../entity/entity.service.js';
import { expandOccurrences, type RecurrenceConfig } from './recurrence.js';

export const DEFAULT_CALENDAR_ENTITIES = ['Task', 'Call', 'Meeting'] as const;

export interface CalendarEventDto {
  activityType: string;
  activityId: string;
  name: string | null;
  status: string | null;
  /** Occurrence start/end in UTC ISO. */
  start: string;
  end: string | null;
  /** Day bucket in the requested time zone, `YYYY-MM-DD`. */
  day: string;
  allDay: boolean;
  assignedUserId: string | null;
  recurring: boolean;
  /** True for the stored base record rather than a generated occurrence. */
  base: boolean;
  duration: number | null;
}

export interface CalendarQuery {
  from: Date;
  to: Date;
  timeZone: string;
  entities: string[];
  userId?: string | undefined;
  maxSize: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function dateOf(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function recurrenceOf(record: Record<string, unknown>): RecurrenceConfig {
  const dayOfWeek = record['repeatDayOfWeek'];
  return {
    repeatType: textOf(record['repeatType']) ?? undefined,
    repeatEvery: typeof record['repeatEvery'] === 'number' ? record['repeatEvery'] : undefined,
    repeatEndDate: dateOf(record['repeatEndDate']) ?? undefined,
    ...(Array.isArray(dayOfWeek) ? { repeatDayOfWeek: dayOfWeek.map(String) } : {}),
    repeatByMonth: textOf(record['repeatByMonth']) ?? undefined,
  };
}

/** `YYYY-MM-DD` of an instant as seen from an IANA time zone. */
export function dayKeyInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '01';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * Calendar read model (PLAN §27). Records are fetched through the generic entity
 * service so record-level ACL and field restrictions apply exactly as on any list.
 */
@Injectable()
export class CalendarService {
  constructor(@Inject(EntityCrudService) private readonly entities: EntityCrudService) {}

  async query(input: CalendarQuery): Promise<CalendarEventDto[]> {
    const events: CalendarEventDto[] = [];
    // recurring bases may start long before the window, so the upper bound is the only filter
    const upperBound = new Date(input.to.getTime() + DAY_MS).toISOString();

    for (const entity of input.entities) {
      const where: Record<string, unknown>[] = [
        { field: 'dateStart', operator: 'isNotNull' },
        { field: 'dateStart', operator: 'lessThanOrEqual', value: upperBound },
      ];
      if (input.userId !== undefined) where.push({ field: 'assignedUserId', operator: 'equals', value: input.userId });

      const result = await this.entities.list(entity, {
        where,
        orderBy: 'dateStart',
        order: 'asc',
        maxSize: input.maxSize,
        total: false,
      });

      for (const record of result.list) {
        const start = dateOf(record['dateStart']);
        if (!start) continue;
        const end = dateOf(record['dateEnd']);
        const storedDuration = typeof record['duration'] === 'number' ? record['duration'] : undefined;
        const durationMs =
          end !== undefined && end.getTime() > start.getTime()
            ? end.getTime() - start.getTime()
            : (storedDuration ?? 0) * 1000;
        const recurrence = recurrenceOf(record);
        const recurring = recurrence.repeatType !== undefined && recurrence.repeatType !== 'None';
        const occurrences = expandOccurrences({
          start,
          durationMs,
          recurrence,
          from: input.from,
          to: input.to,
        });

        for (const occurrence of occurrences) {
          const userId = textOf(record['assignedUserId']);
          if (input.userId !== undefined && userId !== input.userId) continue;
          events.push({
            activityType: entity,
            activityId: String(record['id'] ?? ''),
            name: textOf(record['name']),
            status: textOf(record['status']),
            start: occurrence.start.toISOString(),
            end: occurrence.end?.toISOString() ?? null,
            day: dayKeyInZone(occurrence.start, input.timeZone),
            allDay: record['isAllDay'] === true,
            assignedUserId: userId,
            recurring,
            base: occurrence.start.getTime() === start.getTime(),
            duration: durationMs > 0 ? Math.round(durationMs / 1000) : null,
          });
        }
      }
    }

    events.sort((a, b) => a.start.localeCompare(b.start));
    return events;
  }
}
