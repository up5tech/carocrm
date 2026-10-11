import { DatabaseOutlined, TeamOutlined, TrophyOutlined, UserOutlined } from '@ant-design/icons';
import { Card, Col, Row } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import { navEntities, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';

interface Count {
  entity: string;
  label: string;
  total: number | null;
}

const TONES = ['blue', 'green', 'cyan', 'yellow', 'purple'] as const;
const ICONS: Record<string, ReactNode> = {
  Account: <TeamOutlined />,
  Contact: <UserOutlined />,
  Lead: <DatabaseOutlined />,
  Opportunity: <TrophyOutlined />,
};

/** Landing page: one Lizant stat tile per enabled entity, counts from the generic list API. */
export function HomePage() {
  const metadata = useMetadata();
  const { principal } = useSession();
  const [counts, setCounts] = useState<Count[]>([]);

  const entities = navEntities(metadata.data, principal?.type);

  useEffect(() => {
    if (entities.length === 0) return;
    let active = true;
    void Promise.all(
      entities.map(async (entity) => {
        try {
          const result = await api.list(entity.name, { maxSize: 1 });
          return { entity: entity.name, label: entity.label, total: result.total ?? result.count };
        } catch {
          return { entity: entity.name, label: entity.label, total: null };
        }
      }),
    ).then((rows) => {
      if (active) setCounts(rows);
    });
    return () => {
      active = false;
    };
  }, [metadata.data, principal?.type]);

  const tiles = counts.length > 0 ? counts : entities.map((entity) => ({ entity: entity.name, label: entity.label, total: null }));

  return (
    <>
      <div className="lizant-page-head">
        <div>
          <h1 className="lizant-page-title">Dashboard</h1>
          <p className="lizant-page-sub">Records available in this workspace, rendered from entity metadata.</p>
        </div>
      </div>
      <Row gutter={[16, 16]}>
        {tiles.map((tile, index) => (
          <Col key={tile.entity} xs={24} sm={12} lg={8} xl={6}>
            <Card className="lizant-card">
              <div className="lizant-stat">
                <div>
                  <div className="lizant-label">
                    <Link to={`/${tile.entity}`}>{tile.label}</Link>
                  </div>
                  <div className="lizant-stat-value">{tile.total === null ? '—' : tile.total.toLocaleString()}</div>
                  <div className="lizant-stat-hint">records</div>
                </div>
                <span className={`lizant-stat-icon lizant-stat-icon--${TONES[index % TONES.length]}`}>
                  {ICONS[tile.entity] ?? <DatabaseOutlined />}
                </span>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </>
  );
}
