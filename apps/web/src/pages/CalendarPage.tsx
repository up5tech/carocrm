import { CalendarOutlined, LeftOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Calendar,
  DatePicker,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Tooltip,
} from 'antd';
import calendarEnUS from 'antd/es/calendar/locale/en_US';
import calendarViVN from 'antd/es/calendar/locale/vi_VN';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type CalendarEvent } from '../api/client.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
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
        <span className="carocrm-cal-event-name">{event.name ?? event.activityType}</span>
        {event.recurring ? <span className="carocrm-cal-event-repeat">↻</span> : null}
      </Link>
    </div>
  );
}

/** The bar above the grid: month, navigation, view switch and the entity legend-as-filter. */
function CalendarToolbar(props: {
  readonly title: string;
  readonly count: number;
  readonly view: 'month' | 'week';
  readonly onView: (view: 'month' | 'week') => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onToday: () => void;
  readonly entities: readonly string[];
  readonly onToggleEntity: (name: string) => void;
  readonly entityLabel: (name: string) => string;
}) {
  return (
    <div className="carocrm-cal-toolbar">
      <Space.Compact>
        <Tooltip title={t('web.calendar.prevMonth')}>
          <Button icon={<LeftOutlined />} aria-label={t('web.calendar.prevMonth')} onClick={props.onPrev} />
        </Tooltip>
        <Tooltip title={t('web.calendar.nextMonth')}>
          <Button icon={<RightOutlined />} aria-label={t('web.calendar.nextMonth')} onClick={props.onNext} />
        </Tooltip>
      </Space.Compact>
      <Button onClick={props.onToday}>{t('web.calendar.today')}</Button>

      <div className="carocrm-cal-heading">
        <span className="carocrm-cal-month">{props.title}</span>
        <span className="carocrm-cal-total">{t('web.calendar.entries', { count: String(props.count) })}</span>
      </div>

      <div className="carocrm-cal-toolbar-end">
        <div className="carocrm-cal-filters" role="group" aria-label={t('web.calendar.title')}>
          {ACTIVITY_ENTITIES.map((name) => {
            const on = props.entities.includes(name);
            return (
              <button
                key={name}
                type="button"
                className={`carocrm-cal-filter${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => props.onToggleEntity(name)}
              >
                <span className={`carocrm-cal-dot ${LEGEND_CLASS[name] ?? ''}`} aria-hidden="true" />
                {props.entityLabel(name)}
              </button>
            );
          })}
        </div>
        <Segmented
          value={props.view}
          onChange={(value) => props.onView(value as 'month' | 'week')}
          options={[
            { value: 'month', label: t('web.calendar.viewMonth') },
            { value: 'week', label: t('web.calendar.viewWeek') },
          ]}
        />
      </div>
    </div>
  );
}

/** Calendar view (PLAN §27): month grid of activity occurrences with drag-to-reschedule. */
export function CalendarPage() {
  usePageDocs('user/activities-and-tasks');
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const metadata = useMetadata();
  const locale = activeLocaleName();
  // The panel month drives the grid and the fetch window. Selecting a day is a separate state:
  // a day click used to move the panel, so clicking an adjacent-month cell jumped months.
  const [view, setView] = useState<'month' | 'week'>('month');
  const [month, setMonth] = useState<Dayjs>(() => dayjs().startOf('month'));
  const [week, setWeek] = useState<Dayjs>(() => dayjs().startOf('week'));
  const [selected, setSelected] = useState<Dayjs>(() => dayjs());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [entities, setEntities] = useState<string[]>([...ACTIVITY_ENTITIES]);
  const [onlyMine, setOnlyMine] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState<CalendarEvent | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm();
  const watchedType = (Form.useWatch('activityType', createForm) as string | undefined) ?? 'Task';
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const load = useCallback(async () => {
    if (entities.length === 0) {
      setEvents([]);
      return;
    }
    setLoading(true);
    try {
      const start =
        view === 'week' ? week.startOf('week').startOf('day') : month.startOf('month').startOf('week');
      const end =
        view === 'week' ? week.endOf('week').endOf('day') : month.startOf('month').endOf('month').endOf('week');
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
  }, [view, month, week, entities, onlyMine, principal, zone, message]);

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
  const weekTitle = useMemo(() => {
    const start = week.startOf('week');
    const end = week.endOf('week');
    return `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(start.toDate())} – ${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(end.toDate())}`;
  }, [locale, week]);
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

  const handleCreateTask = async (values: Record<string, unknown>): Promise<void> => {
    setCreating(true);
    try {
      const type = String(values['activityType'] ?? 'Task');
      const isTask = type === 'Task';
      const payload: Record<string, unknown> = {
        name: values['name'],
        status: values['status'] ?? (isTask ? 'Not Started' : 'Planned'),
        ...(values['dateStart'] ? { dateStart: dayjs(values['dateStart'] as string | Dayjs).toISOString() } : {}),
        ...(values['dateEnd'] ? { dateEnd: dayjs(values['dateEnd'] as string | Dayjs).toISOString() } : {}),
        ...(typeof values['description'] === 'string' && values['description'].trim() !== ''
          ? { description: values['description'] }
          : {}),
        ...(principal?.id ? { assignedUserId: principal.id } : {}),
        ...(isTask ? { priority: values['priority'] ?? 'Normal' } : {}),
        ...(type === 'Call' ? { direction: values['direction'] ?? 'Internal' } : {}),
      };
      await api.create(type, payload);
      void message.success(t('web.calendar.taskCreated'));
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.calendar.createTaskFailed'));
    } finally {
      setCreating(false);
    }
  };

  const entityLabel = (name: string): string => metadata.data?.[name]?.label ?? name;
  const toggleEntity = (name: string): void =>
    setEntities((current) => (current.includes(name) ? current.filter((value) => value !== name) : [...current, name]));
  const selectedDay = selected.format('YYYY-MM-DD');
  const selectedEvents = byDay.get(selectedDay) ?? [];
  const weekDays = useMemo(() => {
    const start = week.startOf('week');
    return Array.from({ length: 7 }, (_, index) => start.add(index, 'day'));
  }, [week]);

  useEffect(() => {
    if (!createOpen) return;
    createForm.setFieldsValue({
      activityType: 'Task',
      name: '',
      status: 'Not Started',
      priority: 'Normal',
      direction: 'Internal',
      dateStart: dayjs(selected).hour(9).minute(0).second(0),
      dateEnd: null,
      description: '',
    });
  }, [createOpen, selected, createForm]);

  const goPrev = (): void => {
    if (view === 'week') setWeek((current) => current.subtract(1, 'week'));
    else setMonth((current) => current.subtract(1, 'month'));
  };
  const goNext = (): void => {
    if (view === 'week') setWeek((current) => current.add(1, 'week'));
    else setMonth((current) => current.add(1, 'month'));
  };
  const goToday = (): void => {
    setMonth(dayjs().startOf('month'));
    setWeek(dayjs().startOf('week'));
    setSelected(dayjs());
  };

  /** One day cell, shared by the month grid and the week strip. */
  const renderCell = (date: Dayjs, options: { readonly inMonth: boolean; readonly minHeight?: number }): React.ReactNode => {
    const day = date.format('YYYY-MM-DD');
    const dayEvents = byDay.get(day) ?? [];
    const className = [
      'carocrm-cal-cell',
      options.inMonth ? '' : 'carocrm-cal-cell--out',
      date.isSame(selected, 'day') ? 'carocrm-cal-cell--selected' : '',
      date.isSame(dayjs(), 'day') ? 'carocrm-cal-cell--today' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        className={className}
        data-drag-over={dropDay === day ? 'true' : undefined}
        style={options.minHeight === undefined ? undefined : { minHeight: options.minHeight }}
        onClick={() => setSelected(date)}
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
  };

  return (
    <div className="carocrm-page">
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.calendar.title')}</h1>
          <p className="carocrm-page-sub">{t('web.calendar.hint', { zone })}</p>
        </div>
        <Space size={8} wrap>
          <Segmented
            value={onlyMine ? 'mine' : 'all'}
            onChange={(value) => setOnlyMine(value === 'mine')}
            options={[
              { value: 'all', label: t('web.calendar.everyone') },
              { value: 'mine', label: t('web.calendar.onlyMine') },
            ]}
          />
          <Tooltip title={t('core.common.refresh')}>
            <Button icon={<ReloadOutlined />} aria-label={t('core.common.refresh')} loading={loading} onClick={() => void load()} />
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('web.calendar.createTask')}
          </Button>
        </Space>
      </div>

      <div className="carocrm-cal-panel">
        <CalendarToolbar
          title={view === 'week' ? weekTitle : monthTitle}
          count={events.length}
          view={view}
          onView={setView}
          onPrev={goPrev}
          onNext={goNext}
          onToday={goToday}
          entities={entities}
          onToggleEntity={toggleEntity}
          entityLabel={entityLabel}
        />

        <div className="carocrm-cal-body">
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
            <Spin spinning={loading}>
              {view === 'week' ? (
                <div className="carocrm-cal-week">
                  {weekDays.map((date) => (
                    <div key={date.format('YYYY-MM-DD')} className="carocrm-cal-week-col">
                      <div className="carocrm-cal-week-head">
                        <span className="carocrm-cal-week-dow">
                          {new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date.toDate())}
                        </span>
                      </div>
                      {renderCell(date, { inMonth: true, minHeight: 360 })}
                    </div>
                  ))}
                </div>
              ) : (
                <Calendar
                  value={month}
                  locale={locale.toLowerCase().startsWith('vi') ? calendarViVN : calendarEnUS}
                  headerRender={() => null}
                  onSelect={(date, info) => {
                    if (info.source === 'date') setSelected(date);
                  }}
                  fullCellRender={(date, info) => {
                    if (info.type !== 'date') return info.originNode;
                    const inMonth = date.month() === month.month() && date.year() === month.year();
                    return renderCell(date, { inMonth });
                  }}
                />
              )}
            </Spin>
          </div>

          <aside className="carocrm-cal-agenda" aria-label={t('web.calendar.agenda')}>
            <div className="carocrm-cal-agenda-head">
              <div>
                <div className="carocrm-cal-agenda-title">{selectedTitle}</div>
                <div className="carocrm-cal-agenda-count">
                  {t('web.calendar.entries', { count: String(selectedEvents.length) })}
                </div>
              </div>
            </div>
            {selectedEvents.length === 0 ? (
              <div className="carocrm-cal-agenda-empty">
                <CalendarOutlined />
                <span>{t('web.calendar.dayEmpty')}</span>
              </div>
            ) : (
              <div className="carocrm-cal-agenda-list">
                {selectedEvents.map((event) => (
                  <Link
                    key={`${event.activityType}-${event.activityId}-${event.start}`}
                    to={`/${event.activityType}/${event.activityId}`}
                    className={`carocrm-cal-agenda-item ${EVENT_CLASS[event.activityType] ?? ''}`}
                  >
                    <span className="carocrm-cal-agenda-time">
                      {event.allDay ? t('web.calendar.allDay') : timeOf(event.start)}
                    </span>
                    <span className="carocrm-cal-agenda-main">
                      <span className="carocrm-cal-agenda-name">
                        {event.name ?? event.activityType}
                        {event.recurring ? <span className="carocrm-cal-event-repeat">↻</span> : null}
                      </span>
                      <span className="carocrm-cal-agenda-type">{entityLabel(event.activityType)}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </aside>
        </div>
      </div>

      <Modal
        open={createOpen}
        title={t('web.calendar.createTask')}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={creating}
        destroyOnHidden
        footer={[
          <Button key="cancel" onClick={() => setCreateOpen(false)}>
            {t('core.common.cancel')}
          </Button>,
          <Button key="save" type="primary" loading={creating} onClick={() => createForm.submit()}>
            {t('web.edit.save')}
          </Button>,
          <Button key="create" loading={creating} onClick={() => createForm.submit()}>
            {t('web.list.create')}
          </Button>,
        ]}
      >
        <Form form={createForm} layout="vertical" onFinish={(values) => void handleCreateTask(values as Record<string, unknown>)}>
          <Form.Item name="activityType" label="Type">
            <Select options={['Task', 'Call', 'Meeting'].map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: t('web.edit.required', { field: 'Name' }) }]}>
            <Input autoFocus maxLength={255} />
          </Form.Item>
          <Form.Item name="status" label="Status">
            <Select
              options={(watchedType === 'Task'
                ? ['Not Started', 'Started', 'Completed', 'Canceled', 'Deferred']
                : ['Planned', 'Held', 'Not Held']
              ).map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          {watchedType === 'Task' ? (
            <Form.Item name="priority" label="Priority">
              <Select options={['Low', 'Normal', 'High', 'Urgent'].map((value) => ({ value, label: value }))} />
            </Form.Item>
          ) : null}
          {watchedType === 'Call' ? (
            <Form.Item name="direction" label="Direction">
              <Select options={['Internal', 'Outbound', 'Inbound'].map((value) => ({ value, label: value }))} />
            </Form.Item>
          ) : null}
          <Form.Item name="dateStart" label="Date Start">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="dateEnd" label="Date End">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
