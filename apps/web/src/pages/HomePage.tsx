import { Card, Checkbox, Col, Progress, Row, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import type { SetupChecklistItem } from '../api/types.js';
import { entityIcon } from '../components/entityIcons.js';
import { t } from '../state/i18n.js';
import { navEntities, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';

interface Count {
  entity: string;
  label: string;
  total: number | null;
}

const TONES = ['blue', 'green', 'cyan', 'yellow', 'purple'] as const;
/** Landing page: one Carocrm stat tile per enabled entity, counts from the generic list API. */
export function HomePage() {
  const metadata = useMetadata();
  const { principal } = useSession();
  const [counts, setCounts] = useState<Count[]>([]);

  const entities = navEntities(metadata.data, principal?.type);

  const tiles = counts.length > 0 ? counts : entities.map((entity) => ({ entity: entity.name, label: entity.label, total: null }));

  useEffect(() => {
    if (entities.length === 0) return;
    let active = true;
    // Paint every tile as "unknown" first, then fill each count in as it arrives — the grid must
    // not wait for the slowest entity before the user sees anything.
    setCounts(entities.map((entity) => ({ entity: entity.name, label: entity.label, total: null })));
    for (const entity of entities) {
      void api
        .list(entity.name, { maxSize: 1 })
        .then((result) => {
          if (!active) return;
          const total = result.total ?? result.count ?? null;
          setCounts((current) => current.map((count) => (count.entity === entity.name ? { ...count, total } : count)));
        })
        .catch(() => {
          // An entity the generic list refuses keeps its "—": the tile still links through.
        });
    }
    return () => {
      active = false;
    };
  }, [metadata.data, principal?.type]);

  return (
    <>
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.home.title')}</h1>
          <p className="carocrm-page-sub">{t('web.home.subtitle')}</p>
        </div>
      </div>
      <Row gutter={[16, 16]}>
        {tiles.map((tile, index) => (
          <Col key={tile.entity} xs={24} sm={12} lg={8} xl={6}>
            <Card className="carocrm-card">
              <div className="carocrm-stat">
                <div>
                  <div className="carocrm-label">
                    <Link to={`/${tile.entity}`}>{tile.label}</Link>
                  </div>
                  <div className="carocrm-stat-value">{typeof tile.total === 'number' ? tile.total.toLocaleString() : '—'}</div>
                  <div className="carocrm-stat-hint">{t('web.home.records')}</div>
                </div>
                <span className={`carocrm-stat-icon carocrm-stat-icon--${TONES[index % TONES.length]}`}>
                  {entityIcon(metadata.data?.[tile.entity]?.icon, tile.entity)}
                </span>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* §20.15: setup checklist for administrators */}
      {principal?.type === 'admin' ? <SetupChecklistPanel /> : null}
    </>
  );
}

function SetupChecklistPanel() {
  const [items, setItems] = useState<SetupChecklistItem[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.setupChecklist().then((data) => {
      setItems(data.items);
      setProgress(data.progress);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading || items.length === 0) return null;
  const allDone = progress.done === progress.total;

  return (
    <Card className="carocrm-card" title={t('web.setup.title')} style={{ marginTop: 24 }} role="region" aria-label={t('web.setup.ariaLabel')}>
      {allDone ? (
        <Typography.Text type="success">{t('web.setup.allDone')}</Typography.Text>
      ) : (
        <>
          <Progress percent={Math.round((progress.done / progress.total) * 100)} status="active" style={{ marginBottom: 16 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Checkbox checked={item.completed} disabled />
                <Link to={item.route} style={{ flex: 1 }}>
                  <Typography.Text strong={item.completed}>{t(item.labelKey)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{t(item.descriptionKey)}</Typography.Text>
                </Link>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
