/**
 * Phase 19-S.17 — shared line-item editor (PLAN_Phase_19_Sales.md §9.3).
 *
 * A reusable table editor for document line items: add products, edit quantity/price/discount/tax,
 * reorder, remove, and preview server-calculated totals. The editor never trusts client-submitted
 * totals — it sends lines to `previewTotals` and displays the server's figures.
 */

import {
  Button,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import { t } from '../state/i18n.js';

const { Text } = Typography;

interface LineItem {
  id: string;
  productId?: string | null;
  name: string;
  sku?: string | null;
  unit?: string | null;
  quantity: string;
  unitPrice?: string | null;
  listPrice?: string | null;
  discount?: string | null;
  tax?: string | null;
  lineTotal?: string | null;
  position: number;
  error?: string;
}

interface Totals {
  subtotal: string;
  discountTotal: string;
  shippingAmount: string;
  shippingTaxAmount: string;
  taxTotal: string;
  netTotal: string;
  grossTotal: string;
  amountDue: string;
  currency: string;
}

interface LineItemEditorProps {
  value: LineItem[];
  onChange: (lines: LineItem[]) => void;
  currency?: string | null;
  disabled?: boolean;
  /** Price resolution endpoint input builder. Optional: when provided, the editor can resolve prices. */
  resolvePriceInput?: (productId: string, quantity: string) => Record<string, unknown>;
  /** Product lookup options: [{ label, value: productId }]. */
  productOptions?: { label: string; value: string }[];
  /** Custom line permission. When false, custom lines are hidden. */
  allowCustomLines?: boolean;
}

export function LineItemEditor({
  value,
  onChange,
  currency,
  disabled = false,
  resolvePriceInput,
  productOptions,
  allowCustomLines = false,
}: LineItemEditorProps) {
  const [lines, setLines] = useState<LineItem[]>(value);
  const [previewing, setPreviewing] = useState(false);
  const [totals, setTotals] = useState<Totals | null>(null);

  const productMap = useMemo(() => {
    const map = new Map<string, { label: string; sku?: string }>();
    for (const opt of productOptions ?? []) map.set(opt.value, { label: opt.label });
    return map;
  }, [productOptions]);

  const columns: ColumnsType<LineItem> = useMemo(
    () => [
      {
        title: t('sales.document.lineItem'),
        dataIndex: 'name',
        key: 'name',
        width: 220,
        render: (_, record) => (
          <Text strong>{record.name}{record.sku ? ` (${record.sku})` : ''}</Text>
        ),
      },
      {
        title: t('sales.document.quantity'),
        dataIndex: 'quantity',
        key: 'quantity',
        width: 110,
        render: (quantity, record) => (
          <InputNumber
            min={0}
            value={Number(quantity) || 0}
            disabled={disabled}
            onChange={(v) => {
              if (v === undefined) return;
              const next = [...lines];
              next[record.position as number] = { ...record, quantity: String(v) };
              setLines(next);
              onChange(next);
              void previewTotals(next);
            }}
          />
        ),
      },
      {
        title: t('sales.document.unitPrice'),
        dataIndex: 'unitPrice',
        key: 'unitPrice',
        width: 130,
        render: (unitPrice, record) => (
          <Input
            value={unitPrice ?? ''}
            disabled={disabled}
            placeholder={t('sales.document.noPrice')}
            onChange={(e) => {
              const next = [...lines];
              next[record.position as number] = { ...record, unitPrice: e.target.value.trim() || null };
              setLines(next);
              onChange(next);
            }}
          />
        ),
      },
      {
        title: t('sales.document.discount'),
        dataIndex: 'discount',
        key: 'discount',
        width: 110,
        render: (discount, record) => (
          <Input
            value={discount ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const next = [...lines];
              next[record.position as number] = { ...record, discount: e.target.value.trim() || null };
              setLines(next);
              onChange(next);
            }}
          />
        ),
      },
      {
        title: t('sales.document.tax'),
        dataIndex: 'tax',
        key: 'tax',
        width: 100,
        render: (tax, record) => (
          <Input value={tax ?? ''} disabled={disabled} onChange={(e) => {
            const next = [...lines];
            next[record.position as number] = { ...record, tax: e.target.value.trim() || null };
            setLines(next);
            onChange(next);
          }} />
        ),
      },
      {
        title: t('sales.document.lineTotal'),
        dataIndex: 'lineTotal',
        key: 'lineTotal',
        width: 130,
        render: (_lineTotal, record) => <Text>{record.lineTotal ?? '—'}</Text>,
      },
      {
        title: '',
        dataIndex: 'actions',
        key: 'actions',
        width: 80,
        render: (_, record) => (
          <Space size="small">
            <Button
              icon={<Tag />}
              size="small"
              disabled={disabled}
              onClick={() => {
                const next = lines.filter((l) => l.id !== record.id);
                setLines(next);
                onChange(next);
                void previewTotals(next);
              }}
            >
              {t('sales.lineItem.removeLine')}
            </Button>
          </Space>
        ),
      },
    ],
    [lines, disabled, t],
  );

  const previewTotals = useCallback(
    async (nextLines: LineItem[]) => {
      if (!resolvePriceInput) return;
      setPreviewing(true);
      try {
        const input = {
          lines: nextLines.map((l) => ({
            productId: l.productId ?? null,
            name: l.name,
            sku: l.sku ?? null,
            unit: l.unit ?? null,
            quantity: l.quantity,
            unitPrice: l.unitPrice ?? null,
            discount: l.discount ?? null,
            tax: l.tax ?? null,
          })),
          currency,
        };
        const result = await api.salesPreviewTotals(input);
        setTotals(result.totals as unknown as Totals);
      } catch {
        // Totals preview is advisory; a failure must not block editing.
        setTotals(null);
      } finally {
        setPreviewing(false);
      }
    },
    [currency, resolvePriceInput],
  );

  const addLine = useCallback(() => {
    const next = [
      ...lines,
      {
        id: `line-${Date.now()}`,
        name: '',
        sku: null,
        unit: null,
        quantity: '1',
        unitPrice: null,
        discount: null,
        tax: null,
        lineTotal: null,
        position: lines.length,
      },
    ];
    setLines(next);
    onChange(next);
    void previewTotals(next);
  }, [lines, onChange, previewTotals]);

  const addProductLine = useCallback(
    (productId: string) => {
      const opt = productOptions?.find((p) => p.value === productId);
      if (!opt) return;
      const info = productMap.get(productId);
      const next = [
        ...lines,
        {
          id: `line-${Date.now()}`,
          productId,
          name: info?.label ?? opt.label,
          sku: info?.sku ?? null,
          unit: null,
          quantity: '1',
          unitPrice: null,
          discount: null,
          tax: null,
          lineTotal: null,
          position: lines.length,
        },
      ];
      setLines(next);
      onChange(next);
      void previewTotals(next);
    },
    [lines, onChange, productOptions, productMap, previewTotals],
  );

  // Keep local state in sync with the controlled value.
  useEffect(() => {
    setLines(value);
  }, [value]);

  const hasErrors = lines.some((l) => l.error);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button
          type="primary"
          icon={<Tag />}
          disabled={disabled}
          onClick={addLine}
        >
          {t('sales.lineItem.addLine')}
        </Button>
        {allowCustomLines && !disabled && (
          <Select
            showSearch
            placeholder={t('sales.lineItem.addProduct')}
            options={productOptions ?? []}
            onChange={(val) => {
              if (!val) return;
              void addProductLine(val);
            }}
          />
        )}
        {previewing && <span style={{ fontSize: 12, color: '#737b85' }}>{t('sales.lineItem.recalculating')}</span>}
      </div>

      <Table
        columns={columns}
        dataSource={lines}
        rowKey="id"
        size="middle"
        pagination={false}
        scroll={{ x: 1200 }}
        loading={previewing}
      />

      {totals && <CardTotals totals={totals} />}

      {hasErrors && (
        <div style={{ color: '#cf1322', fontSize: 12, marginTop: 8 }}>
          {t('sales.document.conflict')}
        </div>
      )}
    </Space>
  );
}

function CardTotals({ totals }: { totals: Totals }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, marginTop: 8 }}>
      <div style={{ textAlign: 'right' }}>
        <Text style={{ color: 'rgba(0,0,0,0.45)' }}>{t('sales.document.subtotal')}:</Text>
        <Text>{totals.subtotal}</Text>
      </div>
      <div style={{ textAlign: 'right' }}>
        <Text style={{ color: 'rgba(0,0,0,0.45)' }}>{t('sales.document.discountTotal')}:</Text>
        <Text>{totals.discountTotal}</Text>
      </div>
      <div style={{ textAlign: 'right' }}>
        <Text style={{ color: 'rgba(0,0,0,0.45)' }}>{t('sales.document.shippingAmount')}:</Text>
        <Text>{totals.shippingAmount}</Text>
      </div>
      <div style={{ textAlign: 'right' }}>
        <Text style={{ color: 'rgba(0,0,0,0.45)' }}>{t('sales.document.taxTotal')}:</Text>
        <Text>{totals.taxTotal}</Text>
      </div>
      <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 4, textAlign: 'right' }}>
        <Text strong>{t('sales.document.grossTotal')}:</Text>
        <Text strong>{totals.grossTotal}</Text>
      </div>
    </div>
  );
}
