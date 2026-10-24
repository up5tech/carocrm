import { CalendarOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { Link } from 'react-router-dom';

import { formatClock, t } from '../../state/i18n.js';
import { useMetadata } from '../../state/metadata.js';
import { agendaSlice } from './home-model.js';
import { HomeSkeleton } from './HomeSkeleton.js';
import { useHomeAgenda } from './useHomeData.js';

/** The accent of a type dot — the same four activity types the calendar legend uses. */
const TYPE_CLASS: Record<string, string> = {
  Call: 'carocrm-home-dot--call',
  Meeting: 'carocrm-home-dot--meeting',
  ProjectTask: 'carocrm-home-dot--project',
  Task: 'carocrm-home-dot--task',
};

/**
 * "What is on today" (PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * Up to six entries with a time gutter and a type dot; the rest are counted and linked rather than
 * dropped. An empty day says so — the card never shows a blank rectangle.
 */
export function TodayAgenda() {
  const agenda = useHomeAgenda();
  const metadata = useMetadata();
  const slice = agendaSlice(agenda.events, agenda.dayKey, 6);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const label = (entityType: string): string => metadata.data?.[entityType]?.label ?? entityType;

  return (
    <section className="carocrm-home-panel carocrm-home-agenda" aria-labelledby="carocrm-home-agenda-title">
      <header className="carocrm-home-panel-head">
        <h2 id="carocrm-home-agenda-title" className="carocrm-home-panel-title">
          {t('web.home.agenda.title')}
        </h2>
        <Link to="/calendar" className="carocrm-home-panel-link">
          {t('web.home.agenda.open')}
        </Link>
      </header>

      {agenda.isError ? (
        <div className="carocrm-home-panel-error" role="alert">
          <span>{t('web.home.error')}</span>
          <Button size="small" onClick={() => void agenda.refetch()}>
            {t('web.home.retry')}
          </Button>
        </div>
      ) : agenda.isPending ? (
        <div className="carocrm-home-agenda-list" aria-busy="true">
          <HomeSkeleton rows={3} />
        </div>
      ) : slice.events.length === 0 ? (
        <div className="carocrm-home-agenda-empty">
          <CalendarOutlined aria-hidden="true" />
          <span>{t('web.home.agenda.empty')}</span>
        </div>
      ) : (
        <>
          <ul className="carocrm-home-agenda-list">
            {slice.events.map((event) => (
              <li key={`${event.activityType}-${event.activityId}-${event.start}`}>
                <Link to={`/${event.activityType}/${event.activityId}`} className="carocrm-home-agenda-item">
                  <span className="carocrm-home-agenda-time">
                    {event.allDay ? t('web.calendar.allDay') : formatClock(event.start, zone)}
                  </span>
                  <span className={`carocrm-home-dot ${TYPE_CLASS[event.activityType] ?? ''}`} aria-hidden="true" />
                  <span className="carocrm-home-agenda-main">
                    <span className="carocrm-home-agenda-name">{event.name ?? event.activityType}</span>
                    <span className="carocrm-home-agenda-type">{label(event.activityType)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {slice.hidden > 0 ? (
            <Link to="/calendar" className="carocrm-home-agenda-more">
              {t('web.home.agenda.more', { count: slice.hidden })}
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}
