import { BulbOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { useNavigate } from 'react-router-dom';

import { formatNumber, t } from '../../state/i18n.js';
import { briefingSignals, dayEvents } from './home-model.js';
import { useHomeAgenda, useHomeApprovals, useHomeTasks } from './useHomeData.js';

/**
 * P2 proactive briefing card — deterministic, no model call.
 *
 * Each bullet re-states an already-visible, ACL-checked signal (overdue tasks assigned to
 * me, today's calendar, approvals waiting). The card never invents urgency and never calls
 * a provider: the only AI involvement is the deep link into Chat ("prioritize my day"),
 * where the answer is grounded in the same CRM data through the ACL-checked tools.
 */
export function AIBriefingCard() {
  const navigate = useNavigate();
  const tasks = useHomeTasks();
  const agenda = useHomeAgenda();
  const approvals = useHomeApprovals();

  if (tasks.isPending || agenda.isPending || approvals.isPending) {
    return (
      <div className="carocrm-home-briefing" aria-busy="true">
        <span className="carocrm-home-focus-label">{t('web.ai.briefing.title')}</span>
        <span className="carocrm-home-skeleton carocrm-home-skeleton--value" />
      </div>
    );
  }

  if (tasks.isError || agenda.isError || approvals.isError) {
    const failed = [tasks, agenda, approvals].find((query) => query.isError);
    return (
      <div className="carocrm-home-briefing" role="group" aria-label={t('web.ai.briefing.title')}>
        <span className="carocrm-home-focus-label">{t('web.ai.briefing.title')}</span>
        <span className="carocrm-home-focus-hint">{t('web.home.error')}</span>
        <Button size="small" onClick={() => void failed?.refetch()}>
          {t('web.home.retry')}
        </Button>
      </div>
    );
  }

  const now = agenda.now ?? new Date();
  const signals = briefingSignals({
    tasks: tasks.data?.list ?? [],
    todayEvents: dayEvents(agenda.events, agenda.dayKey),
    approvals: approvals.data?.total ?? 0,
    now,
  });

  return (
    <div className="carocrm-home-briefing" aria-label={t('web.ai.briefing.title')}>
      <span className="carocrm-home-focus-head">
        <span className="carocrm-home-focus-icon" aria-hidden="true">
          <BulbOutlined />
        </span>
        <span className="carocrm-home-focus-label">{t('web.ai.briefing.title')}</span>
      </span>
      {signals.length === 0 ? (
        <span className="carocrm-home-focus-hint">{t('web.ai.briefing.clear')}</span>
      ) : (
        <span className="carocrm-home-focus-lines">
          {signals.map((signal) => (
            <span key={signal.key} className="carocrm-home-focus-line">
              {t(`web.ai.briefing.${signal.key}`, { count: formatNumber(signal.count) })}
              {signal.examples.length > 0 ? ` — ${signal.examples.join(', ')}` : ''}
            </span>
          ))}
        </span>
      )}
      <Button
        size="small"
        onClick={() => navigate(`/crm-chat?ask=${encodeURIComponent(t('web.ai.briefing.ask'))}`)}
      >
        {t('web.ai.briefing.askAction')}
      </Button>
    </div>
  );
}
