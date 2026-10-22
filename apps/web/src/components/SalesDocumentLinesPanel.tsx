/**
 * Phase 19-S.17 — the line-item panel of a commercial document (§9.3, §9.4).
 *
 * The document's header is edited by the generic metadata form; its **lines** cannot be, because a
 * line only means something together with the price resolution, tax resolution and totals the server
 * computes. So this panel replaces the plain `items` relationship table on a document's detail screen
 * with the shared editor, and writes through the document command (`PATCH /Sales/document/:kind/:id`)
 * rather than by creating item records one at a time.
 *
 * Three consequences worth stating, because they are the whole point of the panel:
 *
 *  - the totals shown are the **server's** (`previewTotals` on edit, the document's own totals after a
 *    save), never a client-side sum of what was typed;
 *  - an issued document is **read-only here**: its lines are the ones its snapshot froze, and the only
 *    supported correction is a credit note or a new document (§4.7, §4.9);
 *  - a refusal is surfaced with the server's reason, because "the price is missing" and "you may not
 *    edit an issued invoice" need different answers from the user.
 */

import { ReloadOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Space, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { SalesDocumentView } from '../api/types.js';
import { salesDocumentDate } from '../sales/documents.js';
import { t } from '../state/i18n.js';
import { DocumentSendModal } from './DocumentSendModal.js';
import type { SalesLine, SalesLineTotals } from './LineItemEditor.js';
import { lineFromItem, LineItemEditor, linePayload } from './LineItemEditor.js';
import { SalesDocumentActions } from './SalesDocumentActions.js';
import { useSalesPickers } from './useSalesPickers.js';

interface SalesDocumentLinesPanelProps {
  readonly kind: string;
  readonly id: string;
}

function mapTotals(source: Record<string, unknown> | undefined, currency: string): SalesLineTotals | null {
  if (!source) return null;
  return {
    subtotal: String(source['subtotal'] ?? '0'),
    discountTotal: String(source['discountTotal'] ?? '0'),
    shippingAmount: String(source['shippingAmount'] ?? '0'),
    shippingTaxAmount: String(source['shippingTaxAmount'] ?? '0'),
    taxTotal: String(source['taxTotal'] ?? '0'),
    netTotal: String(source['netTotal'] ?? '0'),
    grossTotal: String(source['grossTotal'] ?? '0'),
    currency: String(source['currency'] ?? currency),
    taxBreakdown: ((source['taxBreakdown'] ?? []) as Record<string, unknown>[]).map((row) => ({
      code: String(row['taxCodeName'] ?? row['taxCodeId'] ?? '—'),
      rate: String(row['taxRatePercent'] ?? ''),
      base: String(row['taxableBase'] ?? ''),
      amount: String(row['taxAmount'] ?? ''),
    })),
    warnings: ((source['warnings'] ?? []) as unknown[]).map((warning) => String(warning)),
  };
}

export function SalesDocumentLinesPanel({ kind, id }: SalesDocumentLinesPanelProps) {
  const { message } = AntApp.useApp();
  const [view, setView] = useState<SalesDocumentView | null>(null);
  const [lines, setLines] = useState<SalesLine[]>([]);
  const [totals, setTotals] = useState<SalesLineTotals | null>(null);
  const { products, taxCodes } = useSalesPickers();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const document = await api.salesReadDocument(kind, id);
      setView(document);
      setLines((document.items ?? []).map((item) => lineFromItem(item)));
      const currency = String(document.document['currency'] ?? 'USD');
      setTotals(mapTotals(document.totals as Record<string, unknown> | undefined, currency));
    } catch (error) {
      // A 403 and a 404 both mean "this panel has nothing to show"; the reason is the useful part.
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [kind, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const locked = view?.lock?.locked === true;
  // A named line with no price cannot be saved — the totals engine refuses it, and §4.3 is explicit
  // that a missing price is never treated as zero. Blocking the action and saying why beats letting
  // the user discover it as a red toast after a click.
  const unpriced = lines.filter((line) => line.name.trim() !== '' && !line.unitPrice);
  const currency = String(view?.document['currency'] ?? 'USD');
  const dateField = salesDocumentDate(kind, view?.document ?? {});

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.salesUpdateDocument(kind, id, { items: lines.map(linePayload) });
      void message.success(t('sales.document.linesSaved'));
      setDirty(false);
      await load();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      void message.error(error instanceof Error ? error.message : t('sales.document.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [id, kind, lines, load, message]);

  const recalculate = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.salesRecalculateDocument(kind, id);
      await load();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [id, kind, load]);

  if (loadError !== null) {
    return (
      <Card className="carocrm-card" title={<Typography.Text strong>{t('sales.document.lines')}</Typography.Text>}>
        <Alert type="error" showIcon message={t('sales.document.linesFailed')} description={loadError} />
      </Card>
    );
  }

  return (
    <Card
      className="carocrm-card carocrm-document-lines-card"
      size="small"
      loading={loading}
      title={
        <Space size={8}>
          <Typography.Text strong>{t('sales.document.lines')}</Typography.Text>
          {view ? <Typography.Text type="secondary">{view.descriptor.label}</Typography.Text> : null}
        </Space>
      }
      extra={
        <Space size={4}>
          <Button
            icon={<SendOutlined />}
            disabled={view === null}
            onClick={() => setSendOpen(true)}
          >
            {t('sales.document.send')}
          </Button>
          <Button icon={<ReloadOutlined />} disabled={saving || locked} onClick={() => void recalculate()}>
            {t('sales.lineItem.recalculate')}
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            disabled={saving || locked || !dirty || unpriced.length > 0}
            title={unpriced.length > 0 ? t('sales.lineItem.priceRequired') : undefined}
            onClick={() => void save()}
          >
            {t('web.common.save')}
          </Button>
        </Space>
      }
    >
      {locked ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('sales.document.lockedDocument')}
          description={t('sales.document.issuedFromSnapshot')}
        />
      ) : null}
      {/* The document's own commands — issue, void, confirm, cancel, convert, unlock — come from the
          server's descriptor, so this panel never has to know a state machine (§9.4). */}
      {view ? <SalesDocumentActions view={view} onChanged={() => void load()} /> : null}
      {saveError !== null ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={saveError} /> : null}
      {unpriced.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('sales.lineItem.priceRequired')}
          description={`${t('sales.lineItem.priceUnresolvedHint')} (${unpriced
            .map((line) => line.name)
            .join(', ')})`}
        />
      ) : null}
      <LineItemEditor
        lines={lines}
        onChange={(next) => {
          setLines(next);
          setDirty(true);
        }}
        currency={currency}
        date={dateField}
        taxInclusive={view?.document['taxInclusive'] === true}
        accountId={(view?.document['accountId'] as string | null) ?? null}
        priceBookId={(view?.document['priceBookId'] as string | null) ?? null}
        products={products}
        taxCodes={taxCodes}
        allowCustomLines
        disabled={locked}
        initialTotals={totals}
        onTotalsChange={setTotals}
        onPreviewError={setSaveError}
      />
      {view ? (
        <DocumentSendModal
          open={sendOpen}
          kind={kind}
          entity={view.descriptor.entity}
          id={id}
          onClose={() => setSendOpen(false)}
          onSent={() => {
            void message.success(t('sales.document.sendDone'));
            // Sending can issue the document, so the lines, the lock and the state all come back fresh.
            void load();
          }}
        />
      ) : null}
    </Card>
  );
}
