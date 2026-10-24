import { CalendarOutlined, CheckSquareOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { Link } from 'react-router-dom';

import { formatClock, formatDateTime, formatNumber, t } from '../../state/i18n.js';
import { agendaSlice, nearestDue, overdueCount } from './home-model.js';
import { useHomeAgenda, useHomeApprovals, useHomeTasks } from './useHomeData.js';

/**
 * The three cards under the hero (PLAN_Phase_20_Settings_UX.md §5.6, §20.19): what needs an answer,
 * what is on today, what is waiting for a decision.
 *
 * Each card is one link — no nested controls — so the whole card is a single tab stop and its
 * accessible name carries the number it shows. A card whose source failed keeps its place, says so
 * and offers Retry; the other two keep working.
 */
function FocusCard(props: {
  readonly to: string;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: number;
  readonly hint: string;
  readonly lines: string[];
  readonly ariaLabel: string;
}) {
  return (
    <Link to={props.to} className="carocrm-home-focus-card" aria-label={props.ariaLabel}>
      <span className="carocrm-home-focus-head">
        <span className="carocrm-home-focus-icon" aria-hidden="true">
          {props.icon}
        </span>
        <span className="carocrm-home-focus-label">{props.label}</span>
        <span className="carocrm-home-focus-count">{formatNumber(props.value)}</span>
      </span>
      <span className="carocrm-home-focus-hint">{props.hint}</span>
      {props.lines.length > 0 ? (
        <span className="carocrm-home-focus-lines">
          {props.lines.map((line, index) => (
            // Two tasks can share a name and a date, so the position is part of the key.
            <span key={`${line}-${String(index)}`} className="carocrm-home-focus-line">
              {line}
            </span>
          ))}
        </span>
      ) : null}
    </Link>
  );
}

/** A card that could not load: still in the strip, still labelled, with an inline retry. */
function BrokenCard(props: { readonly icon: React.ReactNode; readonly label: string; readonly onRetry: () => void }) {
  return (
    <div className="carocrm-home-focus-card is-broken" role="group" aria-label={props.label}>
      <span className="carocrm-home-focus-head">
        <span className="carocrm-home-focus-icon" aria-hidden="true">
          {props.icon}
        </span>
        <span className="carocrm-home-focus-label">{props.label}</span>
      </span>
      <span className="carocrm-home-focus-hint">{t('web.home.error')}</span>
      <Button size="small" onClick={props.onRetry}>
        {t('web.home.retry')}
      </Button>
    </div>
  );
}

export function FocusStrip() {
  const tasks = useHomeTasks();
  const agenda = useHomeAgenda();
  const approvals = useHomeApprovals();

  const now = new Date();
  const taskList = tasks.data?.list ?? [];
  const taskTotal = tasks.data?.total ?? taskList.length;
  const overdue = overdueCount(taskList, now);
  const due = nearestDue(taskList, 2);
  const overdueText = t('web.home.focus.overdue', { count: overdue });
  const tasksClear = t('web.home.focus.tasksClear');

  const slice = agendaSlice(agenda.events, agenda.dayKey, 6);
  const todayCount = slice.events.length + slice.hidden;
  const next = slice.events[0];
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const running = approvals.data?.total ?? 0;

  return (
    <div className="carocrm-home-focus-strip">
      {tasks.isError ? (
        <BrokenCard icon={<CheckSquareOutlined />} label={t('web.home.focus.cardTasks')} onRetry={() => void tasks.refetch()} />
      ) : tasks.isPending ? (
        <div className="carocrm-home-focus-card is-loading" aria-busy="true">
          <span className="carocrm-home-focus-label">{t('web.home.focus.cardTasks')}</span>
          <span className="carocrm-home-skeleton carocrm-home-skeleton--value" />
        </div>
      ) : (
        <FocusCard
          to="/tasks"
          icon={<CheckSquareOutlined />}
          label={t('web.home.focus.cardTasks')}
          value={taskTotal}
          hint={overdue > 0 ? overdueText : tasksClear}
          lines={due.map((task) => `${task.name} · ${formatDateTime(task.dueAt, false)}`)}
          ariaLabel={`${t('web.home.focus.cardTasks')}: ${taskTotal}. ${overdue > 0 ? overdueText : tasksClear}`}
        />
      )}

      {agenda.isError ? (
        <BrokenCard icon={<CalendarOutlined />} label={t('web.home.focus.cardToday')} onRetry={() => void agenda.refetch()} />
      ) : agenda.isPending ? (
        <div className="carocrm-home-focus-card is-loading" aria-busy="true">
          <span className="carocrm-home-focus-label">{t('web.home.focus.cardToday')}</span>
          <span className="carocrm-home-skeleton carocrm-home-skeleton--value" />
        </div>
      ) : (
        <FocusCard
          to="/calendar"
          icon={<CalendarOutlined />}
          label={t('web.home.focus.cardToday')}
          value={todayCount}
          hint={
            next === undefined
              ? t('web.home.focus.none')
              : `${next.allDay ? t('web.calendar.allDay') : formatClock(next.start, zone)} · ${next.name ?? next.activityType}`
          }
          lines={slice.events.slice(1, 3).map((event) => `${event.allDay ? t('web.calendar.allDay') : formatClock(event.start, zone)} · ${event.name ?? event.activityType}`)}
          ariaLabel={t('web.home.focus.today', { count: todayCount })}
        />
      )}

      {approvals.isError ? (
        <BrokenCard icon={<ClockCircleOutlined />} label={t('web.home.focus.cardApprovals')} onRetry={() => void approvals.refetch()} />
      ) : approvals.isPending ? (
        <div className="carocrm-home-focus-card is-loading" aria-busy="true">
          <span className="carocrm-home-focus-label">{t('web.home.focus.cardApprovals')}</span>
          <span className="carocrm-home-skeleton carocrm-home-skeleton--value" />
        </div>
      ) : (
        <FocusCard
          to="/tasks?tab=approvals"
          icon={<ClockCircleOutlined />}
          label={t('web.home.focus.cardApprovals')}
          value={running}
          hint={t('web.home.focus.running', { count: running })}
          lines={[]}
          ariaLabel={`${t('web.home.focus.cardApprovals')}: ${running}. ${t('web.home.focus.running', { count: running })}`}
        />
      )}
    </div>
  );
}
