import { ReloadOutlined } from '@ant-design/icons';
import { App as AntApp, Badge, Button, Calendar, Card, Checkbox, Segmented, Space, Spin, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type CalendarEvent } from '../api/client.js';
import { useSession } from '../state/session.js';

// Phase 19 adds ProjectTask: a project task with a date shows on the calendar, read-only (§4.13).
const ACTIVITY_ENTITIES = ['Task', 'Call', 'Meeting', 'ProjectTask'] as const;

const TYPE_COLOR: Record<string, string> = { Task: 'blue', Call: 'cyan', Meeting: 'purple', ProjectTask: 'geekblue' };

/** A day cell shows this many events, then counts the rest instead of hiding them silently. */
const CELL_EVENTS = 6;

function timeOf(iso: string): string {
  return dayjs(iso).format('HH:mm');
}

/** Calendar view (PLAN §27): month grid of activity occurrences with drag-to-reschedule. */
export function CalendarPage() {
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const [current, setCurrent] = useState<Dayjs>(dayjs());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [entities, setEntities] = useState<string[]>([...ACTIVITY_ENTITIES]);
  const [onlyMine, setOnlyMine] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState<CalendarEvent | null>(null);
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const load = useCallback(async () => {
    if (entities.length === 0) {
      setEvents([]);
      return;
    }
    setLoading(true);
    try {
      const start = current.startOf('month').startOf('week');
      const end = current.endOf('month').endOf('week');
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
      void message.error(error instanceof Error ? error.message : 'Failed to load the calendar.');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [current, entities, onlyMine, principal, zone, message]);

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
      void message.success(`Moved to ${target.format('YYYY-MM-DD HH:mm')}.`);
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Failed to reschedule.');
    }
  };

  return (
    <Card
      className="lizant-card"
      title={<Typography.Title level={4} className="lizant-page-title" style={{ margin: 0 }}>Calendar</Typography.Title>}
      extra={
        <Space wrap size={12}>
          <Checkbox.Group
            options={[...ACTIVITY_ENTITIES]}
            value={entities}
            onChange={(values) => setEntities(values.map(String))}
          />
          <Segmented
            value={onlyMine ? 'mine' : 'all'}
            onChange={(value) => setOnlyMine(value === 'mine')}
            options={[
              { value: 'all', label: 'Everyone' },
              { value: 'mine', label: 'Only mine' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            Refresh
          </Button>
        </Space>
      }
    >
      <Spin spinning={loading}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Time zone {zone}. Drag an entry onto another day to reschedule it.
        </Typography.Text>
        <Calendar
          value={current}
          onPanelChange={(value) => setCurrent(value)}
          onSelect={(value) => setCurrent(value)}
          fullCellRender={(date, info) => {
            if (info.type !== 'date') return info.originNode;
            const day = date.format('YYYY-MM-DD');
            const dayEvents = byDay.get(day) ?? [];
            return (
              <div
                className="lizant-cal-cell"
                onDragOver={(event) => {
                  if (dragging) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const dropped = dragging;
                  setDragging(null);
                  if (dropped) void reschedule(dropped, day);
                }}
              >
                {info.originNode}
                <div className="lizant-cal-events">
                  {dayEvents.slice(0, CELL_EVENTS).map((event) => (
                    <Tag
                      key={`${event.activityType}-${event.activityId}-${event.start}`}
                      className="lizant-cal-tag"
                      color={TYPE_COLOR[event.activityType] ?? 'default'}
                      draggable
                      onDragStart={() => setDragging(event)}
                      title={`${event.name ?? ''} · ${timeOf(event.start)}${event.recurring ? ' · recurring' : ''}`}
                    >
                      <Link to={`/${event.activityType}/${event.activityId}`} onClick={(e) => e.stopPropagation()}>
                        {timeOf(event.start)} {event.name ?? event.activityType}
                      </Link>
                    </Tag>
                  ))}
                  {dayEvents.length > CELL_EVENTS ? <Badge count={`+${String(dayEvents.length - CELL_EVENTS)}`} /> : null}
                </div>
              </div>
            );
          }}
        />
      </Spin>
    </Card>
  );
}
