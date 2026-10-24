import { useMemo } from 'react';
import { Link } from 'react-router-dom';

import { pickDefaultDashboard } from '../../state/dashboard-default.js';
import { formatNumber, t } from '../../state/i18n.js';
import { usePreference } from '../../state/preferences.js';
import { useSession } from '../../state/session.js';
import { kpiDashletsOf } from './home-model.js';
import { HomeSkeleton } from './HomeSkeleton.js';
import { useHomeDashboards, useHomePulse } from './useHomeData.js';

/**
 * "What is the pulse" (PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * At most three KPI dashlets from the dashboard the user lands on — curated by an administrator in
 * Dashboards, never a hard-coded list here. No dashboard, no KPI dashlet or a failed request means the
 * panel is simply absent: home never falls back to counting every module.
 */
export function PulseStrip() {
  const dashboards = useHomeDashboards();
  const preferred = usePreference<string | null>('defaultDashboard');
  const { principal } = useSession();

  // Same rule as the Dashboards page, so the two screens always show the same board.
  const picked = useMemo(
    () => pickDefaultDashboard(dashboards.data ?? [], preferred.value, principal?.roles ?? []),
    [dashboards.data, preferred.value, principal?.roles],
  );
  const active = useMemo(() => dashboards.data?.find((dashboard) => dashboard.id === picked?.id) ?? null, [dashboards.data, picked]);
  const pulse = useHomePulse(active);

  // A query that is disabled never leaves its pending state, so only a board that has KPI dashlets
  // can be waited on; otherwise the rail decides as soon as the lists are known.
  const hasKpi = active !== null && kpiDashletsOf(active).length > 0;
  const waiting = dashboards.isPending || preferred.value === undefined || (hasKpi && pulse.isPending);
  const tiles = pulse.data ?? [];

  // Nothing configured (or the board could not be read): the rail is absent, not a wall of zeros.
  if (!waiting && (dashboards.isError || active === null || tiles.length === 0)) return null;

  return (
    <section className="carocrm-home-panel carocrm-home-pulse" aria-labelledby="carocrm-home-pulse-title">
      <header className="carocrm-home-panel-head">
        <h2 id="carocrm-home-pulse-title" className="carocrm-home-panel-title">
          {t('web.home.pulse.title')}
        </h2>
        <Link to="/dashboards" className="carocrm-home-panel-link">
          {t('web.home.pulse.link')}
        </Link>
      </header>
      {waiting ? (
        <div className="carocrm-home-kpis" aria-busy="true">
          <HomeSkeleton rows={2} />
        </div>
      ) : (
        <div className="carocrm-home-kpis">
          {tiles.map((tile, index) => (
            // Dashlets may share a name; the position is what makes the tile unique on this rail.
            <div key={`${tile.name}-${String(index)}`} className="carocrm-home-kpi">
              <span className="carocrm-home-kpi-label">{tile.name}</span>
              <span className="carocrm-home-kpi-value">{tile.value === null ? '—' : formatNumber(tile.value)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
