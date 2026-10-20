/**
 * Phase 19-S.17 — the commercial hand-off from a CRM Opportunity (§4.5, §4.6, §4.7).
 *
 * The command behind this panel is `POST /Sales/document/fromOpportunity`: it reads the deal under the
 * caller's own access, copies the party, writes the provenance in both directions and applies the
 * double-billing guards. What the panel adds is the entry point, and one honest constraint:
 *
 * **a document cannot exist without at least one priced line** (the totals engine refuses an empty
 * one, and the rule is pinned by its own test). So the button does not create anything here — it
 * opens the create screen for the kind, seeded with the deal, where the line editor prices the lines
 * and the save goes through the same command. Creating an empty draft behind the user's back would
 * only produce a refusal.
 *
 * The three kinds are the ones an Opportunity can produce; the purchasing kinds are absent because a
 * supplier is not a deal.
 */

import { PlusOutlined } from '@ant-design/icons';
import { Button, Card, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';

import { t } from '../state/i18n.js';

interface OpportunityDocumentActionsProps {
  readonly opportunityId: string;
}

/** Entity + label key for each kind an Opportunity can be raised into, in commercial order. */
const OPPORTUNITY_KINDS: readonly { entity: string; key: string }[] = [
  { entity: 'Quote', key: 'quote' },
  { entity: 'SalesOrder', key: 'salesOrder' },
  { entity: 'Invoice', key: 'invoice' },
];

export function OpportunityDocumentActions({ opportunityId }: OpportunityDocumentActionsProps) {
  const navigate = useNavigate();

  return (
    <Card className="carocrm-card" title={<Typography.Text strong>{t('sales.opportunity.title')}</Typography.Text>}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t('sales.opportunity.hint')}
      </Typography.Paragraph>
      <Space wrap size={8}>
        {OPPORTUNITY_KINDS.map((kind) => (
          <Button
            key={kind.entity}
            icon={<PlusOutlined />}
            onClick={() => navigate(`/${kind.entity}/create?opportunityId=${encodeURIComponent(opportunityId)}`)}
          >
            {t(`sales.opportunity.create.${kind.key}`)}
          </Button>
        ))}
      </Space>
    </Card>
  );
}
