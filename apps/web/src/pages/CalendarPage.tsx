import { LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Calendar,
  Card,
  Checkbox,
  Segmented,
  Space,
  Spin,
  Typography,
} from 'antd';
import calendarEnUS from 'antd/es/calendar/locale/en_US';
import calendarViVN from 'antd/es/calendar/locale/vi_VN';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type CalendarEvent } from '../api/client.js';
import { DocsLink } from '../components/docs/DocsLink.js';
import { activeLocaleName, t } from '../state/i18n.js';
import { useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';

// Phase 19 adds ProjectTask: a project task with a date shows on the calendar, read-only (§4.13).
const ACTIVITY_ENTITIES = ['Task', 'Call', 'Meeting', 'ProjectTask'] as const;

/** The chip accent per activity type — the entity filter row doubles as the colour legend. */
const EVENT_CLASS: Record<string, string> = {
  Call: 'carocrm-cal-event--call',
  Meeting: 'carocrm-cal-event--meeting',
  ProjectTask: 'carocrm-cal-event--project-task',
  Task: 'carocrm-cal-event--task',
};

const LEGEND_CLASS: Record<string, string> = {
  Call: 'carocrm-cal-dot--call',
  Meeting: 'carocrm-cal-dot--meeting',
  ProjectTask: 'carocrm-cal-dot--project-task',
  Task: 'carocrm-cal-dot--task',
};

/** A day cell shows this many events, then counts the rest instead of hiding them silently. */
const CELL_EVENTS = 4;

function timeOf(iso: string): string {
  return dayjs(iso).format('HH:mm');
}

function eventTitle(event: CalendarEvent): string {
  const when = event.allDay ? t('web.calendar.allDay') : timeOf(event.start);
  return `${event.name ?? ''} · ${when}${event.recurring ? t('web.calendar.recurringSuffix') : ''}`;
}

function EventChip({
  event,
  onDragStart,
  onDragEnd,
}: {
  event: CalendarEvent;
  onDragStart: (event: CalendarEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className={`carocrm-cal-event ${EVENT_CLASS[event.activityType] ?? ''}`}
      draggable
      title={eventTitle(event)}
      onDragStart={() => onDragStart(event)}
      onDragEnd={onDragEnd}
    >
      <Link to={`/${event.activityType}/${event.activityId}`} onClick={(e) => e.stopPropagation()}>
        {!event.allDay ? <span className="carocrm-cal-event-time">{timeOf(event.start)}</span> : null}
        {event.name ?? event.activityType}
        {event.recurring ? <span className="carocrm-cal-event-repeat">↻</span> : null}
      </Link>
    </div>
  );
}

/** Calendar view (PLAN §27): month grid of activity occurrences with drag-to-reschedule. */
export function CalendarPage() {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const metadata = useMetadata();
  const locale = activeLocaleName();
  // The panel month drives the grid and the fetch window. Selecting a day is a separate state:
  // a day click used to move the panel, so clicking an adjacent-month cell jumped months.
  const [month, setMonth] = useState<Dayjs>(() => dayjs().startOf('month'));
  const [selected, setSelected] = useState<Dayjs>(() => dayjs());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [entities, setEntities] = useState<string[]>([...ACTIVITY_ENTITIES]);
  const [onlyMine, setOnlyMine] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState<CalendarEvent | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const load = useCallback(async () => {
    if (entities.length === 0) {
      setEvents([]);
      return;
    }
    setLoading(true);
    try {
      const start = month.startOf('month').startOf('week');
      const end = month.startOf('month').endOf('month').endOf('week');
      const result = await api.calendar({
        from: start.toISOString(),
        to: end.toISOString(),
        timeZone: zone,
        entities,
        maxSize: 500,
        ...(onlyMine && principal ? { userId: principal.id } : {}),
      });
      setEvents(result.list);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.calendar.loadFailed'));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [month, entities, onlyMine, principal, zone, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const list = grouped.get(event.day) ?? [];
      list.push(event);
      grouped.set(event.day, list);
    }
    for (const list of grouped.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return grouped;
  }, [events]);

  const monthTitle = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month.toDate()),
    [locale, month],
  );
  const selectedTitle = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(selected.toDate()),
    [locale, selected],
  );

  const stopDrag = () => {
    setDragging(null);
    setDropDay(null);
  };

  const reschedule = async (event: CalendarEvent, day: string): Promise<void> => {
    const original = dayjs(event.start);
    // dayjs parses without an offset as local time, so this keeps the wall-clock time of day
    const target = dayjs(`${day}T${original.format('HH:mm:ss')}`);
    if (!target.isValid()) return;
    try {
      const record = await api.get(event.activityType, event.activityId);
      const payload: Record<string, unknown> = {
        dateStart: target.toISOString(),
        version: record['version'],
      };
      if (event.end !== null) {
        const durationSeconds = dayjs(event.end).diff(original, 'second');
        if (durationSeconds > 0) payload['dateEnd'] = target.add(durationSeconds, 'second').toISOString();
      }
      await api.update(event.activityType, event.activityId, payload);
      void message.success(t('web.calendar.moved', { date: target.format('YYYY-MM-DD HH:mm') }));
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.calendar.moveFailed'));
    }
  };

  const entityLabel = (name: string): string => metadata.data?.[name]?.label ?? name;
  const selectedDay = selected.format('YYYY-MM-DD');
  const selectedEvents = byDay.get(selectedDay) ?? [];

  return (
    <Card
      className="carocrm-card"
      title={(
          <Space>
            <Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>{t('web.calendar.title')}</Typography.Title>
            <DocsLink docKey="user/activities-and-tasks" compact />
          </Space>
        )}
      extra={
        <Space wrap size={12}>
          <Space wrap size={4}>
            {ACTIVITY_ENTITIES.map((name) => (
              <Checkbox
                key={name}
                checked={entities.includes(name)}
                onChange={(e) =>
                  setEntities((current) => (e.target.checked ? [...current, name] : current.filter((value) => value !== name)))
                }
              >
                <span className="carocrm-cal-legend">
                  <span className={`carocrm-cal-dot ${LEGEND_CLASS[name] ?? ''}`} />
                  {entityLabel(name)}
                </span>
              </Checkbox>
            ))}
          </Space>
          <Segmented
            value={onlyMine ? 'mine' : 'all'}
            onChange={(value) => setOnlyMine(value === 'mine')}
            options={[
              { value: 'all', label: t('web.calendar.everyone') },
              { value: 'mine', label: t('web.calendar.onlyMine') },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            {t('core.common.refresh')}
          </Button>
        </Space>
      }
    >
      <Spin spinning={loading}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('web.calendar.hint', { zone })}
        </Typography.Text>
        <div
          className="carocrm-cal-grid"
          onClickCapture={(event) => {
            const target = event.target;
            if (!(target instanceof Element) || target.closest('a')) return;
            // rc-picker keeps its own visible month and follows every clicked cell, so an
            // adjacent-month cell moved the grid even though `month` never changed.
            const cell = target.closest('.ant-picker-cell');
            if (cell && !cell.classList.contains('ant-picker-cell-in-view')) event.stopPropagation();
          }}
        >
          <Calendar
            value={month}
            locale={locale.toLowerCase().startsWith('vi') ? calendarViVN : calendarEnUS}
            headerRender={() => (
              <div className="carocrm-cal-header">
                <Space.Compact>
                  <Button icon={<LeftOutlined />} aria-label={t('web.calendar.prevMonth')} onClick={() => setMonth((m) => m.subtract(1, 'month'))} />
                  <Button icon={<RightOutlined />} aria-label={t('web.calendar.nextMonth')} onClick={() => setMonth((m) => m.add(1, 'month'))} />
                </Space.Compact>
                <Button onClick={() => { setMonth(dayjs().startOf('month')); setSelected(dayjs()); }}>
                  {t('web.calendar.today')}
                </Button>
                <Typography.Text className="carocrm-cal-month">{monthTitle}</Typography.Text>
                <Typography.Text type="secondary" className="carocrm-cal-total">
                  {t('web.calendar.entries', { count: String(events.length) })}
                </Typography.Text>
              </div>
            )}
            onSelect={(date, info) => {
              if (info.source === 'date') setSelected(date);
            }}
            fullCellRender={(date, info) => {
              if (info.type !== 'date') return info.originNode;
              const day = date.format('YYYY-MM-DD');
              const dayEvents = byDay.get(day) ?? [];
              const inMonth = date.month() === month.month() && date.year() === month.year();
              const className = [
                'carocrm-cal-cell',
                inMonth ? '' : 'carocrm-cal-cell--out',
                date.isSame(selected, 'day') ? 'carocrm-cal-cell--selected' : '',
                date.isSame(dayjs(), 'day') ? 'carocrm-cal-cell--today' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  className={className}
                  data-drag-over={dropDay === day ? 'true' : undefined}
                  onDragOver={(event) => {
                    if (!dragging) return;
                    event.preventDefault();
                    if (dropDay !== day) setDropDay(day);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const dropped = dragging;
                    stopDrag();
                    if (dropped) void reschedule(dropped, day);
                  }}
                >
                  <span className="carocrm-cal-day">{String(date.date())}</span>
                  <div className="carocrm-cal-events">
                    {dayEvents.slice(0, CELL_EVENTS).map((event) => (
                      <EventChip
                        key={`${event.activityType}-${event.activityId}-${event.start}`}
                        event={event}
                        onDragStart={setDragging}
                        onDragEnd={stopDrag}
                      />
                    ))}
                    {dayEvents.length > CELL_EVENTS ? (
                      <span className="carocrm-cal-more">{t('web.calendar.more', { count: String(dayEvents.length - CELL_EVENTS) })}</span>
                    ) : null}
                  </div>
                </div>
              );
            }}
          />
        </div>
        <div className="carocrm-cal-day-panel">
          <Typography.Text className="carocrm-cal-day-panel-title">{selectedTitle}</Typography.Text>
          {selectedEvents.length === 0 ? (
            <Typography.Text type="secondary">{t('web.calendar.dayEmpty')}</Typography.Text>
          ) : (
            <div className="carocrm-cal-day-list">
              {selectedEvents.map((event) => (
                <EventChip
                  key={`${event.activityType}-${event.activityId}-${event.start}`}
                  event={event}
                  onDragStart={setDragging}
                  onDragEnd={stopDrag}
                />
              ))}
            </div>
          )}
        </div>
      </Spin>
    </Card>
  );
}
