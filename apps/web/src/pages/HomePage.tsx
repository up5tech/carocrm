import { usePageDocs } from '../components/docs/PageDocs.js';
import { useSession } from '../state/session.js';
import { ActivityFeed } from './home/ActivityFeed.js';
import { FocusStrip } from './home/FocusStrip.js';
import { HomeHero } from './home/HomeHero.js';
import { PulseStrip } from './home/PulseStrip.js';
import { SetupBanner } from './home/SetupBanner.js';
import { TodayAgenda } from './home/TodayAgenda.js';

/**
 * The home workspace (PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * Four questions, in this order: what needs me now (the focus strip), what is on today (the agenda),
 * what is the pulse (at most three KPI dashlets of the user's default dashboard) and what changed (the
 * followed stream). It is not an inventory of the module list: there is no tile per enabled entity and
 * no request per module, so the page stays the same size however many modules an instance enables.
 */
export function HomePage() {
  usePageDocs('getting-started/home');
  const { principal } = useSession();

  return (
    <div className="carocrm-home">
      <HomeHero principal={principal} />
      <SetupBanner />
      <FocusStrip />
      <div className="carocrm-home-body">
        <TodayAgenda />
        <div className="carocrm-home-side">
          <PulseStrip />
          <ActivityFeed />
        </div>
      </div>
    </div>
  );
}
