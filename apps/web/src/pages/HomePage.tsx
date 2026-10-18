import { Card, Col, Row } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
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
    </>
  );
}
