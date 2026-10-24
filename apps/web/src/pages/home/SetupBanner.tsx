import { CloseOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { Link } from 'react-router-dom';

import { t } from '../../state/i18n.js';
import { usePreference } from '../../state/preferences.js';
import { useSession } from '../../state/session.js';
import { useHomeSetup } from './useHomeData.js';

/**
 * The first-run checklist as a slim banner under the hero (PLAN_Phase_20_Settings_UX.md §4.10, §20.19).
 *
 * Administrators only, while the checklist is incomplete: progress plus the next two steps, each a
 * deep link. At 100 % it disappears, and a user who is not an administrator never sees it at all.
 * It is guidance — it writes nothing by itself, and the administrator can dismiss it per user
 * (`setupChecklistDismissed`), because an instance that will never have SMTP must not nag forever.
 */
export function SetupBanner() {
  const { principal } = useSession();
  const isAdmin = principal?.type === 'admin';
  const setup = useHomeSetup(isAdmin);
  const dismissed = usePreference<boolean>('setupChecklistDismissed');

  // Wait for the stored answer before painting: showing the banner and then removing it reads as a
  // glitch, and the checklist is not urgent enough to flash.
  if (!isAdmin || dismissed.value === undefined || dismissed.value === true) return null;
  const data = setup.data;
  if (setup.isPending || setup.isError || data === undefined) return null;
  const { done, total } = data.progress;
  if (total === 0 || done >= total) return null;

  const percent = Math.round((done / total) * 100);
  const next = data.items.filter((item) => !item.completed).slice(0, 2);

  return (
    <section className="carocrm-home-setup" aria-label={t('web.home.setup.title')}>
      <div className="carocrm-home-setup-main">
        <span className="carocrm-home-setup-title">{t('web.home.setup.title')}</span>
        <span className="carocrm-home-setup-progress">{t('web.home.setup.progress', { done, total })}</span>
        <Button
          size="small"
          type="text"
          aria-label={t('web.home.setup.dismiss')}
          title={t('web.home.setup.dismiss')}
          icon={<CloseOutlined />}
          onClick={() => dismissed.save(true)}
        />
      </div>
      <div className="carocrm-home-setup-bar" aria-hidden="true">
        <span className="carocrm-home-setup-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="carocrm-home-setup-next">
        <span className="carocrm-home-setup-next-label">{t('web.home.setup.next')}</span>
        {next.map((item) => (
          <Link key={item.id} to={item.route} className="carocrm-home-setup-step">
            {t(item.labelKey)}
          </Link>
        ))}
      </div>
    </section>
  );
}
