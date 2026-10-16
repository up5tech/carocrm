/**
 * Phase 19-S.17 — the shared line-item editor (§9.3).
 *
 * One table editor reused by every commercial document kind. Two rules shape it:
 *
 *  - **the client never computes a total.** Every amount shown as a total, and every per-line
 *    net/tax/gross, comes back from `POST /Sales/action/previewTotals` — the same engine the server
 *    uses when the document is saved and issued. The local values are only ever what the user typed.
 *  - **a price is resolved, not guessed.** Picking a product asks `POST /Sales/action/resolvePrice`
 *    and shows *why* that price won (price book, product price, quantity break), because §4.3 makes
 *    the explanation part of the feature. An unresolved line stays visibly unpriced: the server
 *    refuses a missing price at issuance rather than treating it as zero.
 *
 * Rows are keyed by a client-only id, never by their position: a position doubles as an array index
 * the moment a line is removed, and editing a row would then write into its neighbour.
 */

import {
  AlertOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  CalculatorOutlined,
  DeleteOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { Alert, Button, Input, InputNumber, Select, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api/client.js';
import { t } from '../state/i18n.js';

const { Text } = Typography;

/** One editable line. The money fields are canonical decimal strings, as everywhere in Sales. */
export interface SalesLine {
  /** Client-only stable row id. Never sent to the server. */
  readonly key: string;
  productId: string | null;
  name: string;
  sku: string | null;
  unit: string | null;
  quantity: string;
  unitPrice: string | null;
  discountPercent: string | null;
  discountAmount: string | null;
  taxCodeId: string | null;
  taxRatePercent: string | null;
  /** The stored line's id, when this row came from a saved document. */
  itemId?: string | undefined;
  /** Server-computed amounts from the last preview. */
  netAmount?: string | undefined;
  taxAmount?: string | undefined;
  grossAmount?: string | undefined;
  /** Why `unitPrice` is what it is (`resolvePrice`'s explanation). */
  priceSource?: string | undefined;
  /** True when a price was asked for and none applies (§4.3 "a missing price is never zero"). */
  priceUnresolved?: boolean | undefined;
}

/** The totals panel — the server's own `TotalsResult`, subset to what the editor shows. */
export interface SalesLineTotals {
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly shippingAmount: string;
  readonly shippingTaxAmount: string;
  readonly taxTotal: string;
  readonly netTotal: string;
  readonly grossTotal: string;
  readonly currency: string;
  readonly taxBreakdown: readonly { code: string; rate: string; base: string; amount: string }[];
  readonly warnings: readonly string[];
}

export interface LineProductOption {
  readonly value: string;
  readonly label: string;
  readonly sku?: string | null;
  readonly unit?: string | null;
  readonly listPrice?: string | null;
}

export interface LineItemEditorProps {
  lines: SalesLine[];
  onChange: (lines: SalesLine[]) => void;
  currency: string;
  /** The document date the prices and tax rates are resolved as of (`YYYY-MM-DD`). */
  date?: string | null;
  taxInclusive?: boolean;
  accountId?: string | null;
  priceBookId?: string | null;
  products: readonly LineProductOption[];
  taxCodes: readonly { value: string; label: string }[];
  /** A line without a product. Off unless the installation allows custom prices (§4.3). */
  allowCustomLines?: boolean;
  disabled?: boolean;
  /** Totals from the loaded document, shown until the first preview replaces them. */
  initialTotals?: SalesLineTotals | null;
  /** Latest server totals, so the page can render them wherever it likes. */
  onTotalsChange?: (totals: SalesLineTotals | null) => void;
  /** A preview that the server refused (an unusable line), already human-readable. */
  onPreviewError?: (reason: string | null) => void;
}

/** A new, empty line. `key` is generated once and kept, so removals never renumber the others. */
export function newLine(seed: Partial<SalesLine> = {}): SalesLine {
  return {
    key: `line-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    productId: null,
    name: '',
    sku: null,
    unit: null,
    quantity: '1',
    unitPrice: null,
    discountPercent: null,
    discountAmount: null,
    taxCodeId: null,
    taxRatePercent: null,
    ...seed,
  };
}

/** A stored `*Item` record as an editable line. */
export function lineFromItem(item: Record<string, unknown>): SalesLine {
  return newLine({
    itemId: String(item['id'] ?? ''),
    productId: (item['productId'] as string | null) ?? null,
    name: (item['name'] as string | null) ?? '',
    sku: (item['sku'] as string | null) ?? null,
    unit: (item['unit'] as string | null) ?? null,
    quantity: (item['quantity'] as string | null) ?? '1',
    unitPrice: (item['unitPrice'] as string | null) ?? null,
    discountPercent: (item['discountPercent'] as string | null) ?? null,
    discountAmount: (item['discountAmount'] as string | null) ?? null,
    taxCodeId: (item['taxCodeId'] as string | null) ?? null,
    taxRatePercent: (item['taxRatePercent'] as string | null) ?? null,
    netAmount: (item['netAmount'] as string | undefined) ?? undefined,
    taxAmount: (item['taxAmount'] as string | undefined) ?? undefined,
    grossAmount: (item['grossAmount'] as string | undefined) ?? undefined,
  });
}

/** The line payload the document commands and the totals preview accept (both are strict). */
export function linePayload(line: SalesLine): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    quantity: line.quantity,
    // Never a silent zero: an unpriced line is surfaced by the editor and blocked by the panel, and
    // the server refuses it too (§4.3). `''` is what the strict decimal schema rejects, so nothing can
    // reach a document priced at nothing by accident.
    unitPrice: line.unitPrice ?? '',
  };
  if (line.productId) payload['productId'] = line.productId;
  if (line.name) payload['name'] = line.name;
  if (line.sku) payload['sku'] = line.sku;
  if (line.unit) payload['unit'] = line.unit;
  if (line.discountPercent) payload['discountPercent'] = line.discountPercent;
  if (line.discountAmount) payload['discountAmount'] = line.discountAmount;
  if (line.taxCodeId) payload['taxCodeId'] = line.taxCodeId;
  if (line.taxRatePercent) payload['taxRatePercent'] = line.taxRatePercent;
  return payload;
}

const isFilled = (line: SalesLine): boolean =>
  line.name.trim() !== '' && line.quantity.trim() !== '' && line.unitPrice !== null && line.unitPrice !== '';

export function LineItemEditor({
  lines,
  onChange,
  currency,
  date = null,
  taxInclusive = false,
  accountId = null,
  priceBookId = null,
  products,
  taxCodes,
  allowCustomLines = false,
  disabled = false,
  initialTotals = null,
  onTotalsChange,
  onPreviewError,
}: LineItemEditorProps) {
  const [totals, setTotals] = useState<SalesLineTotals | null>(initialTotals);
  const [previewing, setPreviewing] = useState(false);
  const [unresolved, setUnresolved] = useState<ReadonlySet<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest lines, for the debounced preview to read without re-subscribing on every keystroke.
  const latest = useRef(lines);
  latest.current = lines;

  const productMap = useMemo(() => {
    const map = new Map<string, LineProductOption>();
    for (const option of products) map.set(option.value, option);
    return map;
  }, [products]);

  // Every edit path is a plain function of the current `lines`: the component re-renders on each
  // keystroke anyway, and memoising these would only hide a stale closure behind a stable identity.
  const apply = (next: SalesLine[]): void => {
    onChange(next);
    schedulePreview(next);
  };

  const update = (key: string, patch: Partial<SalesLine>): void => {
    apply(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const patchTotals = useCallback((next: SalesLine[], result: PreviewResult | null): SalesLine[] => {
    if (result === null) return next;
    return next.map((line) => {
      const computed = result.linesByKey.get(line.key);
      if (computed === undefined) return line;
      return {
        ...line,
        netAmount: computed.netAmount,
        taxAmount: computed.taxAmount,
        grossAmount: computed.grossAmount,
      };
    });
  }, []);

  interface PreviewResult {
    totals: SalesLineTotals;
    linesByKey: Map<string, { netAmount: string; taxAmount: string; grossAmount: string }>;
  }

  const runPreview = useCallback(
    async (source: SalesLine[]) => {
      const previewable = source.filter(isFilled);
      if (previewable.length === 0) {
        setTotals(null);
        setUnresolved(new Set());
        onTotalsChange?.(null);
        onPreviewError?.(null);
        return;
      }
      setPreviewing(true);
      try {
        const result = await api.salesPreviewTotals({
          currency,
          ...(date ? { date } : {}),
          taxInclusive,
          ...(accountId ? { accountId } : {}),
          lines: previewable.map(linePayload),
        });
        const keys = previewable.map((line) => line.key);
        const linesByKey = new Map<string, { netAmount: string; taxAmount: string; grossAmount: string }>();
        (result.lines ?? []).forEach((row, index) => {
          const key = keys[index];
          if (key === undefined) return;
          linesByKey.set(key, {
            netAmount: String(row['netAmount'] ?? ''),
            taxAmount: String(row['taxAmount'] ?? ''),
            grossAmount: String(row['grossAmount'] ?? ''),
          });
        });
        // The response IS the totals object (§7.3): reading a nested `totals` key would silently
        // render zeros, which is the one thing this panel must never do.
        const serverTotals = result as unknown as Record<string, unknown>;
        const next: SalesLineTotals = {
          subtotal: String(serverTotals['subtotal'] ?? '0'),
          discountTotal: String(serverTotals['discountTotal'] ?? '0'),
          shippingAmount: String(serverTotals['shippingAmount'] ?? '0'),
          shippingTaxAmount: String(serverTotals['shippingTaxAmount'] ?? '0'),
          taxTotal: String(serverTotals['taxTotal'] ?? '0'),
          netTotal: String(serverTotals['netTotal'] ?? '0'),
          grossTotal: String(serverTotals['grossTotal'] ?? '0'),
          currency: String(serverTotals['currency'] ?? currency),
          taxBreakdown: ((result.taxBreakdown ?? []) as Record<string, unknown>[]).map((row) => ({
            code: String(row['taxCodeName'] ?? row['taxCodeId'] ?? '—'),
            rate: String(row['taxRatePercent'] ?? ''),
            base: String(row['taxableBase'] ?? ''),
            amount: String(row['taxAmount'] ?? ''),
          })),
          warnings: ((serverTotals['warnings'] ?? []) as unknown[]).map((warning) => String(warning)),
        };
        setTotals(next);
        onTotalsChange?.(next);
        onPreviewError?.(null);
        // A named line with no price is reported as unresolved rather than previewed as zero (§4.3).
        setUnresolved(
          new Set(
            source
              .filter((line) => line.name.trim() !== '' && !line.unitPrice)
              .map((line) => line.key),
          ),
        );
        const patched = patchTotals(latest.current, { totals: next, linesByKey });
        if (patched.some((line, index) => line !== latest.current[index])) onChange(patched);
      } catch (error) {
        // The refusal reason is the useful part: it is the same message the save would produce.
        onPreviewError?.(error instanceof Error ? error.message : String(error));
      } finally {
        setPreviewing(false);
      }
    },
    [currency, date, taxInclusive, accountId, onChange, onPreviewError, onTotalsChange, patchTotals],
  );

  const schedulePreview = useCallback(
    (source: SalesLine[]) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void runPreview(source), 350);
    },
    [runPreview],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // Totals follow the document's own currency and date, not only the lines: an edit to a line already
  // scheduled a preview through `apply`, and reading the lines from the ref keeps this effect to the
  // header changes it is actually about.
  useEffect(() => {
    if (latest.current.length > 0) schedulePreview(latest.current);
  }, [currency, date, taxInclusive, accountId]);

  const resolvePrice = useCallback(
    async (key: string) => {
      const line = lines.find((candidate) => candidate.key === key);
      if (line?.productId === null || line?.productId === undefined) return;
      try {
        const resolved = await api.salesResolvePrice({
          productId: line.productId,
          quantity: line.quantity,
          currency,
          ...(date ? { date } : {}),
          ...(accountId ? { accountId } : {}),
          ...(priceBookId ? { priceBookId } : {}),
        });
        update(key, {
          unitPrice: resolved.price,
          priceSource: `${resolved.source}: ${resolved.explanation}`,
        });
        setUnresolved((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      } catch (error) {
        // "no price applies" is a state of the catalog, not a failure of the editor.
        update(key, { priceSource: error instanceof Error ? error.message : String(error) });
        setUnresolved((previous) => new Set(previous).add(key));
      }
    },
    [accountId, currency, date, lines, priceBookId, update],
  );

  const addProductLine = useCallback(
    (productId: string) => {
      const option = productMap.get(productId);
      if (option === undefined) return;
      const line = newLine({
        productId,
        name: option.label,
        sku: option.sku ?? null,
        unit: option.unit ?? null,
        unitPrice: option.listPrice ?? null,
      });
      apply([...lines, line]);
      if (option.listPrice === null || option.listPrice === undefined) void resolvePrice(line.key);
    },
    [apply, lines, productMap, resolvePrice],
  );

  const move = useCallback(
    (key: string, delta: -1 | 1) => {
      const index = lines.findIndex((line) => line.key === key);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= lines.length) return;
      const next = [...lines];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      apply(next);
    },
    [apply, lines],
  );

  const columns: ColumnsType<SalesLine> = [
    {
      title: t('sales.document.position'),
      key: 'position',
      width: 56,
      render: (_, record) => <Text type="secondary">{lines.findIndex((line) => line.key === record.key) + 1}</Text>,
    },
    {
      title: t('sales.document.product'),
      key: 'product',
      width: 260,
      render: (_, record) =>
        record.productId === null && allowCustomLines ? (
          <Input
            size="small"
            value={record.name}
            disabled={disabled}
            placeholder={t('sales.lineItem.customLine')}
            onChange={(event) => update(record.key, { name: event.target.value })}
          />
        ) : (
          <Space direction="vertical" size={0}>
            <Text strong>{record.name || '—'}</Text>
            {record.sku ? <Text type="secondary">{record.sku}</Text> : null}
          </Space>
        ),
    },
    {
      title: t('sales.document.quantity'),
      key: 'quantity',
      width: 110,
      render: (_, record) => (
        <InputNumber
          size="small"
          min={0}
          value={Number(record.quantity)}
          disabled={disabled}
          aria-label={t('sales.document.quantity')}
          onChange={(value: number | string | null) => update(record.key, { quantity: String(value ?? 0) })}
        />
      ),
    },
    {
      title: t('sales.document.unitPrice'),
      key: 'unitPrice',
      width: 150,
      render: (_, record) => (
        <Space size={4}>
          <InputNumber
            size="small"
            min={0}
            value={record.unitPrice === null ? null : Number(record.unitPrice)}
            disabled={disabled}
            placeholder={t('sales.document.noPrice')}
            aria-label={t('sales.document.unitPrice')}
            onChange={(value: number | string | null) => update(record.key, { unitPrice: value === null ? null : String(value) })}
          />
          {record.productId && !disabled ? (
            <Tooltip title={t('sales.lineItem.recalculate')}>
              <Button
                size="small"
                type="text"
                icon={<CalculatorOutlined />}
                aria-label={t('sales.lineItem.recalculate')}
                onClick={() => void resolvePrice(record.key)}
              />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('sales.document.discount'),
      key: 'discount',
      width: 120,
      render: (_, record) => (
        <InputNumber
          size="small"
          min={0}
          max={100}
          addonAfter="%"
          value={record.discountPercent === null ? null : Number(record.discountPercent)}
          disabled={disabled}
          aria-label={t('sales.document.discount')}
          onChange={(value: number | string | null) => update(record.key, { discountPercent: value === null ? null : String(value) })}
        />
      ),
    },
    {
      title: t('sales.document.tax'),
      key: 'tax',
      width: 190,
      render: (_, record) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Select
            size="small"
            allowClear
            showSearch
            optionFilterProp="label"
            value={record.taxCodeId ?? undefined}
            disabled={disabled}
            placeholder={t('sales.document.tax')}
            aria-label={t('sales.document.tax')}
            options={taxCodes.map((code) => ({ value: code.value, label: code.label }))}
            onChange={(value: string | undefined) => update(record.key, { taxCodeId: value ?? null })}
            style={{ width: '100%' }}
          />
          {/* A tax code is the normal answer, but an install with no code configured yet still has to
              be able to say "this line is taxed at 0%" — the server refuses an *unanswered* tax rather
              than assuming one (`missingTaxPolicy`), and a percent is the other half of that answer. */}
          {record.taxCodeId === null ? (
            <InputNumber
              size="small"
              min={0}
              max={100}
              addonAfter="%"
              value={record.taxRatePercent === null ? null : Number(record.taxRatePercent)}
              disabled={disabled}
              placeholder={t('sales.document.taxRatePercent')}
              aria-label={t('sales.document.taxRatePercent')}
              onChange={(value: number | string | null) =>
                update(record.key, { taxRatePercent: value === null || value === '' ? null : String(value) })
              }
              style={{ width: '100%' }}
            />
          ) : null}
        </Space>
      ),
    },
    {
      title: t('sales.document.lineTotal'),
      key: 'lineTotal',
      width: 150,
      render: (_, record) =>
        record.grossAmount ? (
          <Space direction="vertical" size={0}>
            <Text>{record.grossAmount}</Text>
            <Text type="secondary">
              {record.netAmount ?? '—'} + {record.taxAmount ?? '—'}
            </Text>
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space size={2}>
          <Button
            size="small"
            type="text"
            icon={<ArrowUpOutlined />}
            disabled={disabled || lines[0]?.key === record.key}
            aria-label={`${t('sales.lineItem.reorder')} ↑`}
            onClick={() => move(record.key, -1)}
          />
          <Button
            size="small"
            type="text"
            icon={<ArrowDownOutlined />}
            disabled={disabled || lines[lines.length - 1]?.key === record.key}
            aria-label={`${t('sales.lineItem.reorder')} ↓`}
            onClick={() => move(record.key, 1)}
          />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            disabled={disabled}
            aria-label={t('sales.lineItem.removeLine')}
            onClick={() => apply(lines.filter((line) => line.key !== record.key))}
          />
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Select
          showSearch
          optionFilterProp="label"
          placeholder={t('sales.lineItem.addProduct')}
          disabled={disabled || products.length === 0}
          options={products.map((option) => ({
            value: option.value,
            label: option.sku ? `${option.label} (${option.sku})` : option.label,
          }))}
          onChange={(value: string) => addProductLine(value)}
          style={{ minWidth: 280 }}
          notFoundContent={t('sales.lineItem.noProducts')}
        />
        {allowCustomLines ? (
          <Button icon={<PlusOutlined />} disabled={disabled} onClick={() => apply([...lines, newLine()])}>
            {t('sales.lineItem.addLine')}
          </Button>
        ) : null}
        <Tooltip title={t('sales.lineItem.priceUnresolvedHint')}>
          <Button
            icon={<QuestionCircleOutlined />}
            disabled={disabled || lines.length === 0}
            onClick={() => schedulePreview(lines)}
          >
            {t('sales.lineItem.preview')}
          </Button>
        </Tooltip>
        {previewing ? <Text type="secondary">{t('sales.lineItem.recalculating')}</Text> : null}
      </Space>

      <Table<SalesLine>
        columns={columns}
        dataSource={lines}
        rowKey="key"
        size="small"
        pagination={false}
        scroll={{ x: 1150 }}
        locale={{ emptyText: t('sales.document.lines') }}
      />

      {unresolved.size > 0 ? (
        <Alert
          type="warning"
          showIcon
          icon={<AlertOutlined />}
          message={t('sales.lineItem.priceUnresolved')}
          description={t('sales.lineItem.priceUnresolvedHint')}
        />
      ) : null}

      {totals ? <SalesTotalsPanel totals={totals} /> : null}
    </Space>
  );
}

/** The totals panel (§9.3): server figures only, with the tax breakdown the server resolved. */
export function SalesTotalsPanel({ totals }: { totals: SalesLineTotals }) {
  const rows: readonly [string, string][] = [
    [t('sales.document.subtotal'), totals.subtotal],
    [t('sales.document.discountTotal'), totals.discountTotal],
    [t('sales.document.shippingAmount'), totals.shippingAmount],
    [t('sales.document.taxTotal'), totals.taxTotal],
    [t('sales.document.netTotal'), totals.netTotal],
  ];
  return (
    <div className="sales-totals-panel">
      <div className="sales-totals-panel__rows">
        {rows.map(([label, value]) => (
          <div key={label} className="sales-totals-panel__row">
            <Text type="secondary">{label}</Text>
            <Text>{value}</Text>
          </div>
        ))}
        <div className="sales-totals-panel__row sales-totals-panel__row--total">
          <Text strong>{t('sales.document.grossTotal')}</Text>
          <Text strong>
            {totals.grossTotal} {totals.currency}
          </Text>
        </div>
      </div>
      {totals.taxBreakdown.length > 0 ? (
        <div className="sales-totals-panel__tax">
          <Text type="secondary">{t('sales.document.taxBreakdown')}</Text>
          <ul>
            {totals.taxBreakdown.map((row) => (
              <li key={`${row.code}-${row.rate}`}>
                {row.code} {row.rate}% · {row.base} → {row.amount}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {totals.warnings.map((warning) => (
        <Alert key={warning} type="warning" showIcon message={warning} />
      ))}
    </div>
  );
}
