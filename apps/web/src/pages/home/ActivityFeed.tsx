import { Button } from 'antd';
import { Link } from 'react-router-dom';

import { updateSummary } from '../../components/StreamPanel.js';
import { activeLocaleName, t } from '../../state/i18n.js';
import { useMetadata } from '../../state/metadata.js';
import { authorInitials, relativeLabel } from './home-model.js';
import { HomeSkeleton } from './HomeSkeleton.js';
import { useHomeActivity } from './useHomeData.js';

/**
 * "What changed" (PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * The latest five entries of the stream the user follows — the same entries `/stream?view=followed`
 * lists, with the same generated sentences. An empty feed invites a search instead of showing an
 * empty box.
 */
export function ActivityFeed() {
  const activity = useHomeActivity();
  const metadata = useMetadata();
  const locale = activeLocaleName();
  const now = new Date();

  return (
    <section className="carocrm-home-panel carocrm-home-activity" aria-labelledby="carocrm-home-activity-title">
      <header className="carocrm-home-panel-head">
        <h2 id="carocrm-home-activity-title" className="carocrm-home-panel-title">
          {t('web.home.activity.title')}
        </h2>
        <Link to="/stream?view=followed" className="carocrm-home-panel-link">
          {t('web.home.activity.link')}
        </Link>
      </header>

      {activity.isError ? (
        <div className="carocrm-home-panel-error" role="alert">
          <span>{t('web.home.error')}</span>
          <Button size="small" onClick={() => void activity.refetch()}>
            {t('web.home.retry')}
          </Button>
        </div>
      ) : activity.isPending ? (
        <div className="carocrm-home-activity-list" aria-busy="true">
          <HomeSkeleton rows={3} />
        </div>
      ) : activity.data.length === 0 ? (
        <div className="carocrm-home-activity-empty">
          <span>{t('web.home.activity.empty')}</span>
          <Link to="/search">{t('web.home.activity.follow')}</Link>
        </div>
      ) : (
        <ul className="carocrm-home-activity-list">
          {activity.data.map((item) => {
            const definition = metadata.data?.[item.entityType];
            const body = item.type === 'Update' ? updateSummary(item, definition) : (item.post ?? '');
            const author = item.createdBy;
            const authorName =
              author === null
                ? t('web.stream.unknownUser')
                : `${author.firstName ?? ''} ${author.lastName ?? ''}`.trim() !== ''
                  ? `${author.firstName ?? ''} ${author.lastName ?? ''}`.trim()
                  : author.userName;
            return (
              <li key={item.id} className="carocrm-home-activity-item">
                <span className="carocrm-home-activity-avatar" aria-hidden="true">
                  {authorInitials(author)}
                </span>
                <span className="carocrm-home-activity-main">
                  <span className="carocrm-home-activity-head">
                    <span className="carocrm-home-activity-author">{authorName}</span>
                    <span className="carocrm-home-activity-time">{relativeLabel(item.createdAt, now, locale)}</span>
                  </span>
                  <span className="carocrm-home-activity-body">{body}</span>
                  <Link to={`/${item.entityType}/${item.entityId}`} className="carocrm-home-activity-record">
                    {definition?.label ?? item.entityType}
                  </Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
