import { DashboardOutlined, DownOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Dropdown, Input } from 'antd';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { Principal } from '../../api/types.js';
import { entityIcon } from '../../components/entityIcons.js';
import { formatLongDate, t } from '../../state/i18n.js';
import { navEntities, useMetadata } from '../../state/metadata.js';
import { dayEvents, focusSentence, greetingKey, overdueCount } from './home-model.js';
import { useHomeAgenda, useHomeTasks } from './useHomeData.js';

/**
 * The band at the top of the home workspace (PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * It states the day in one sentence: who you are, what today is, what needs an answer — then the
 * three things a user does from here: find a record, create one, or open the dashboards. The hero is
 * the only large type on the page; every number below it is a card.
 */
export function HomeHero({ principal }: { readonly principal: Principal | null }) {
  const navigate = useNavigate();
  const metadata = useMetadata();
  const tasks = useHomeTasks();
  const agenda = useHomeAgenda();
  const [query, setQuery] = useState('');
  const [now] = useState(() => new Date());

  // Same entities the sidebar offers, alphabetically: the menu is a shortcut, not a second schema.
  const entities = useMemo(() => navEntities(metadata.data, principal?.type), [metadata.data, principal?.type]);
  const createItems = useMemo(
    () =>
      // §4.5: an entity may switch itself out of the global create menu (`nav.quickCreate`,
      // defaulting to true) — the flag the metadata validates is finally consumed here.
      entities
        .filter((entity) => entity.nav?.quickCreate !== false)
        .map((entity) => ({
          key: entity.name,
          icon: entityIcon(entity.icon, entity.name),
          label: entity.label,
          onClick: () => navigate(`/${entity.name}/create`),
        })),
    [entities, navigate],
  );

  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const dateLine = formatLongDate(now, { timeZone: zone });
  const title = principal?.title ?? null;
  const name = principal?.firstName ?? principal?.name ?? principal?.userName ?? '';
  // Nothing is claimed while a source is still loading or failed: a wrong "nothing needs you" is
  // worse than a quiet line, so the sentence stays empty instead of guessing.
  const settled = !tasks.isPending && !agenda.isPending && !tasks.isError && !agenda.isError;
  const sentence = settled
    ? focusSentence(
        {
          tasks: tasks.data?.total ?? tasks.data?.list.length ?? 0,
          overdue: overdueCount(tasks.data?.list ?? [], now),
          // The count the agenda card shows, so the sentence and the card never disagree.
          today: dayEvents(agenda.events, agenda.dayKey).length,
        },
        t,
      )
    : '';

  const submitSearch = (): void => {
    const term = query.trim();
    if (term !== '') navigate(`/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <header className="carocrm-home-hero">
      <div className="carocrm-home-hero-main">
        <h1 className="carocrm-home-greeting">{t(greetingKey(now.getHours()), { name })}</h1>
        <p className="carocrm-home-meta">
          <span>{dateLine}</span>
          {title !== null && title !== '' ? <span className="carocrm-home-meta-role">{title}</span> : null}
        </p>
        <p className="carocrm-home-focus-line">{sentence}</p>
      </div>
      <div className="carocrm-home-hero-actions">
        <div className="carocrm-home-search-wrap">
          <Input
            className="carocrm-home-search"
            prefix={<SearchOutlined />}
            placeholder={t('web.home.searchPlaceholder')}
            aria-label={t('web.home.searchPlaceholder')}
            aria-describedby="carocrm-home-search-hint"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onPressEnter={submitSearch}
            allowClear
            suffix={<kbd className="carocrm-home-kbd">⌘K</kbd>}
          />
          <span id="carocrm-home-search-hint" className="carocrm-visually-hidden">
            {t('web.home.searchHint')}
          </span>
        </div>
        <div className="carocrm-home-hero-buttons">
          <Dropdown
            menu={{ items: createItems }}
            trigger={['click']}
            disabled={createItems.length === 0}
            popupRender={(menu) => <div className="carocrm-home-create-menu">{menu}</div>}
          >
            <Button type="primary" icon={<PlusOutlined />} aria-label={t('web.home.create')}>
              {t('web.home.create')} <DownOutlined className="carocrm-home-create-caret" />
            </Button>
          </Dropdown>
          <Link to="/dashboards" className="carocrm-home-ghost-link">
            <DashboardOutlined />
            <span>{t('web.home.dashboards')}</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
