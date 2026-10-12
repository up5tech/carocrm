import { BarChartOutlined, DeleteOutlined, DownloadOutlined, PlayCircleOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Col, Empty, Input, Popconfirm, Progress, Row, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import type { ReportDefinitionShape, ReportKind, ReportRow, ReportRunResult } from '../api/types.js';
import { fieldLabel, navEntities, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';

interface FilterRow {
  field: string;
  operator: string;
  value: string;
}

const KINDS: { value: ReportKind; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'summary', label: 'Summary' },
  { value: 'grouped', label: 'Grouped' },
  { value: 'chart', label: 'Chart' },
  { value: 'kpi', label: 'KPI' },
];
const SCALAR_TYPES = new Set(['varchar', 'text', 'email', 'phone', 'url', 'enum', 'multiEnum', 'bool', 'int', 'float', 'decimal', 'currency', 'date', 'datetime']);
const NUMERIC_TYPES = new Set(['int', 'float', 'decimal', 'currency']);

export function ReportsPage() {
  const metadata = useMetadata();
  const { principal } = useSession();
  const { message } = AntApp.useApp();
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [reportId, setReportId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('');
  const [kind, setKind] = useState<ReportKind>('list');
  const [columns, setColumns] = useState<string[]>([]);
  const [groupField, setGroupField] = useState('');
  const [grain, setGrain] = useState<'day' | 'month' | 'year'>('month');
  const [metricOperation, setMetricOperation] = useState<'count' | 'sum' | 'avg' | 'min' | 'max'>('count');
  const [metricField, setMetricField] = useState('');
  const [metricName, setMetricName] = useState('records');
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [result, setResult] = useState<ReportRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const entities = useMemo(() => navEntities(metadata.data, principal?.type), [metadata.data, principal?.type]);
  const selectedEntity = entities.find((item) => item.name === entityType);
  const fields = useMemo(
    () => Object.entries(selectedEntity?.fields ?? {}).filter(([, field]) => SCALAR_TYPES.has(field.type)).map(([field, definition]) => ({
      value: field,
      label: fieldLabel(field, definition, metadata.data),
      type: definition.type,
    })),
    [metadata.data, selectedEntity],
  );
  const fieldByName = useMemo(() => new Map(fields.map((field) => [field.value, field])), [fields]);
  const numericFields = fields.filter((field) => NUMERIC_TYPES.has(field.type));
  const groupFieldType = fieldByName.get(groupField)?.type;

  const load = useCallback(async () => {
    try {
      const items = await api.reports();
      setReports(items);
      setReportId((current) => (items.some((item) => item.id === current) ? current : null));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Failed to load reports.');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (entityType !== '' || entities.length === 0) return;
    setEntityType(entities[0]?.name ?? '');
  }, [entities, entityType]);

  const resetBuilder = useCallback(() => {
    setReportId(null);
    setName('');
    setKind('list');
    setColumns([]);
    setGroupField('');
    setMetricOperation('count');
    setMetricField('');
    setMetricName('records');
    setFilters([]);
    setVisibility('private');
    setResult(null);
  }, []);

  const selectReport = useCallback((report: ReportRow) => {
    const definition = report.definition;
    setReportId(report.id);
    setName(report.name);
    setEntityType(definition.entityType);
    setKind(definition.kind);
    setColumns(definition.columns ?? []);
    setGroupField(definition.groupBy?.field ?? '');
    setGrain(definition.groupBy?.grain ?? 'month');
    const metric = definition.metrics[0];
    setMetricOperation(metric?.operation ?? 'count');
    setMetricField(metric?.field ?? '');
    setMetricName(metric?.name ?? 'records');
    setFilters((definition.filters ?? []).flatMap((filter) => {
      if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return [];
      const item = filter as Record<string, unknown>;
      if (typeof item['field'] !== 'string') return [];
      const value = item['value'];
      return [{ field: item['field'], operator: String(item['operator'] ?? 'equals'), value: value === null || value === undefined ? '' : String(value) }];
    }));
    setVisibility(report.visibility);
    setResult(null);
  }, []);

  const definition = useCallback((): ReportDefinitionShape => {
    const next: ReportDefinitionShape = {
      version: 1,
      entityType,
      kind,
      filters: filters.filter((item) => item.field !== '').map((item) => ({ field: item.field, operator: item.operator, value: item.value })),
      columns: kind === 'list' ? columns : [],
      metrics: kind === 'list' ? [] : [{ name: metricName.trim() || 'records', operation: metricOperation, ...(metricOperation === 'count' ? {} : { field: metricField }) }],
    };
    if ((kind === 'grouped' || kind === 'chart') && groupField !== '') {
      next.groupBy = {
        field: groupField,
        ...((groupFieldType === 'date' || groupFieldType === 'datetime') ? { grain } : {}),
      };
    }
    return next;
  }, [columns, entityType, filters, grain, groupField, groupFieldType, kind, metricField, metricName, metricOperation]);

  const runPreview = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.previewReport(definition());
      setResult(response.result);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Report preview failed.');
    } finally {
      setLoading(false);
    }
  }, [definition, message]);

  const save = useCallback(async () => {
    if (name.trim() === '') {
      void message.warning('Enter a report name before saving.');
      return;
    }
    setSaving(true);
    try {
      const input = { name: name.trim(), definition: definition(), visibility };
      const saved = reportId === null ? await api.createReport(input) : await api.updateReport(reportId, input);
      setReportId(saved.id);
      setName(saved.name);
      await load();
      void message.success('Report saved.');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Report could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [definition, load, message, name, reportId, visibility]);

  const runSaved = useCallback(async () => {
    if (reportId === null) {
      await runPreview();
      return;
    }
    setLoading(true);
    try {
      const response = await api.runReport(reportId);
      setResult(response.result);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Report run failed.');
    } finally {
      setLoading(false);
    }
  }, [message, reportId, runPreview]);

  const exportCsv = useCallback(async () => {
    if (reportId === null) {
      void message.warning('Save the report before exporting it.');
      return;
    }
    try {
      const file = await api.exportReport(reportId);
      const url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      if (file.truncated) void message.warning(`Export contains a bounded partial result (${String(file.rows)} rows/groups).`);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'CSV export failed.');
    }
  }, [message, reportId]);

  const remove = useCallback(async () => {
    if (reportId === null) return;
    try {
      await api.deleteReport(reportId);
      resetBuilder();
      await load();
      void message.success('Report deleted.');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Report could not be deleted.');
    }
  }, [load, message, reportId, resetBuilder]);

  const tableColumns = useMemo<ColumnsType<Record<string, unknown>>>(() => {
    if (!result) return [];
    if (result.rows !== undefined) {
      return (result.columns ?? []).map((field) => ({
        title: fieldLabel(field, selectedEntity?.fields[field], metadata.data),
        dataIndex: field,
        key: field,
        ellipsis: true,
      }));
    }
    if (result.groups !== undefined) {
      const metricNames = Object.keys(result.groups[0]?.metrics ?? result.metrics ?? {});
      return [
        { title: groupField === '' ? 'Group' : fieldLabel(groupField, selectedEntity?.fields[groupField], metadata.data), dataIndex: 'key', key: 'key' },
        { title: 'Records', dataIndex: 'count', key: 'count' },
        ...metricNames.map((metric) => ({ title: metric, dataIndex: ['metrics', metric], key: metric })),
      ] as ColumnsType<Record<string, unknown>>;
    }
    return [];
  }, [groupField, metadata.data, result, selectedEntity]);

  const tableData = result?.rows ?? result?.groups?.map((group) => ({ key: group.key, count: group.count, metrics: group.metrics })) ?? [];
  const chartValues = result?.groups ?? [];
  const chartMetric = Object.keys(chartValues[0]?.metrics ?? {})[0];
  const chartMax = chartMetric === undefined ? 0 : Math.max(1, ...chartValues.map((group) => Math.abs(group.metrics[chartMetric] ?? 0)));

  return (
    <>
      <div className="lizant-page-head">
        <div>
          <h1 className="lizant-page-title">Reports</h1>
          <p className="lizant-page-sub">Build saved list, summary, grouped, chart and KPI reports without SQL.</p>
        </div>
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={resetBuilder}>New report</Button>
          <Button icon={<PlayCircleOutlined />} loading={loading} onClick={() => void runSaved()}>Run / preview</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>Save</Button>
          <Button icon={<DownloadOutlined />} disabled={reportId === null} onClick={() => void exportCsv()}>CSV</Button>
          {reportId !== null ? (
            <Popconfirm title="Delete this report?" onConfirm={() => void remove()} okText="Delete">
              <Button danger icon={<DeleteOutlined />} aria-label="Delete report" />
            </Popconfirm>
          ) : null}
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={6}>
          <Card className="lizant-card" title="Saved reports">
            <Space direction="vertical" style={{ width: '100%' }}>
              {reports.map((report) => (
                <Button key={report.id} type={report.id === reportId ? 'primary' : 'default'} block onClick={() => selectReport(report)}>
                  {report.name}{report.isShared ? ' · shared' : ''}
                </Button>
              ))}
              {reports.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No saved reports" /> : null}
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={18}>
          <Card className="lizant-card" title="Report builder" extra={reportId === null ? <Tag color="blue">Unsaved</Tag> : <Tag>{reportId.slice(0, 8)}</Tag>}>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <label htmlFor="report-name">Report name</label>
                <Input id="report-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Quarterly account overview" />
              </Col>
              <Col xs={24} md={6}>
                <label htmlFor="report-entity">Entity</label>
                <Select id="report-entity" style={{ width: '100%' }} value={entityType || undefined} options={entities.map((entity) => ({ value: entity.name, label: entity.label }))} onChange={(value) => { setEntityType(value ?? ''); setColumns([]); setGroupField(''); setFilters([]); }} showSearch optionFilterProp="label" />
              </Col>
              <Col xs={24} md={6}>
                <label htmlFor="report-kind">Report type</label>
                <Select id="report-kind" style={{ width: '100%' }} value={kind} options={KINDS} onChange={(value) => setKind(value)} />
              </Col>
              <Col xs={24}>
                <label htmlFor="report-columns">Columns (list reports)</label>
                <Select id="report-columns" mode="multiple" style={{ width: '100%' }} value={columns} options={fields.map(({ value, label }) => ({ value, label }))} onChange={setColumns} disabled={kind !== 'list'} placeholder="Choose fields to show" />
              </Col>
              {(kind === 'grouped' || kind === 'chart') ? (
                <>
                  <Col xs={24} md={12}>
                    <label htmlFor="report-group">Group by</label>
                    <Select id="report-group" style={{ width: '100%' }} value={groupField || null} options={fields.map(({ value, label }) => ({ value, label }))} onChange={(value) => setGroupField(value ?? '')} showSearch optionFilterProp="label" placeholder="Choose a dimension" />
                  </Col>
                  {(groupFieldType === 'date' || groupFieldType === 'datetime') ? (
                    <Col xs={24} md={12}>
                      <label htmlFor="report-grain">Date bucket (UTC)</label>
                      <Select id="report-grain" style={{ width: '100%' }} value={grain} options={[{ value: 'day', label: 'Day' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }]} onChange={setGrain} />
                    </Col>
                  ) : null}
                </>
              ) : null}
              {kind !== 'list' ? (
                <>
                  <Col xs={24} md={8}>
                    <label htmlFor="report-metric-name">Metric name</label>
                    <Input id="report-metric-name" value={metricName} onChange={(event) => setMetricName(event.target.value)} />
                  </Col>
                  <Col xs={24} md={8}>
                    <label htmlFor="report-metric-operation">Aggregation</label>
                    <Select id="report-metric-operation" style={{ width: '100%' }} value={metricOperation} options={[{ value: 'count', label: 'Count records' }, { value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' }]} onChange={(value) => setMetricOperation(value)} />
                  </Col>
                  <Col xs={24} md={8}>
                    <label htmlFor="report-metric-field">Numeric field</label>
                    <Select id="report-metric-field" style={{ width: '100%' }} value={metricField || null} options={numericFields.map(({ value, label }) => ({ value, label }))} onChange={(value) => setMetricField(value ?? '')} disabled={metricOperation === 'count'} placeholder="Choose field" />
                  </Col>
                </>
              ) : null}
              <Col xs={24}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                  <strong>Filters (AND)</strong>
                  <Button size="small" onClick={() => setFilters((current) => [...current, { field: '', operator: 'equals', value: '' }])}>Add filter</Button>
                </Space>
                <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
                  {filters.map((filter, index) => (
                    <Space key={`filter-${String(index)}`} wrap>
                      <Select aria-label={`Filter field ${String(index + 1)}`} style={{ minWidth: 180 }} value={filter.field || undefined} options={fields.map(({ value, label }) => ({ value, label }))} onChange={(value) => setFilters((current) => current.map((item, i) => i === index ? { ...item, field: value ?? '' } : item))} placeholder="Field" />
                      <Select aria-label={`Filter operator ${String(index + 1)}`} style={{ width: 150 }} value={filter.operator} options={[{ value: 'equals', label: 'Equals' }, { value: 'notEquals', label: 'Does not equal' }, { value: 'contains', label: 'Contains' }, { value: 'greaterThan', label: 'Greater than' }, { value: 'lessThan', label: 'Less than' }, { value: 'isNull', label: 'Is empty' }, { value: 'isNotNull', label: 'Is not empty' }]} onChange={(value) => setFilters((current) => current.map((item, i) => i === index ? { ...item, operator: value } : item))} />
                      <Input aria-label={`Filter value ${String(index + 1)}`} style={{ width: 180 }} value={filter.value} disabled={filter.operator === 'isNull' || filter.operator === 'isNotNull'} onChange={(event) => setFilters((current) => current.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} placeholder="Value" />
                      <Button danger type="text" icon={<DeleteOutlined />} aria-label={`Remove filter ${String(index + 1)}`} onClick={() => setFilters((current) => current.filter((_, i) => i !== index))} />
                    </Space>
                  ))}
                </Space>
              </Col>
              <Col xs={24} md={12}>
                <label htmlFor="report-visibility">Visibility</label>
                <Select id="report-visibility" style={{ width: '100%' }} value={visibility} options={[{ value: 'private', label: 'Private' }, { value: 'shared', label: 'Shared with users who can read the entity' }]} onChange={setVisibility} />
              </Col>
            </Row>
          </Card>

          <Card className="lizant-card" title={<Space><BarChartOutlined />Results</Space>} style={{ marginTop: 16 }}>
            {!result ? <Empty description="Run or preview this report to see results" /> : (
              <>
                {result.truncated ? <Alert type="warning" showIcon message={`Partial result: scanned ${String(result.scanned)} of ${String(result.total)} matching records, or the group limit was reached.`} style={{ marginBottom: 16 }} /> : null}
                <Space style={{ marginBottom: 12 }} wrap>
                  <Tag>{String(result.total)} matching records</Tag>
                  <Tag color={result.truncated ? 'orange' : 'green'}>{result.truncated ? `Scanned ${String(result.scanned)} (partial)` : `Scanned ${String(result.scanned)}`}</Tag>
                </Space>
                {result.metrics ? (
                  <Row gutter={[12, 12]}>
                    {Object.entries(result.metrics).map(([label, value]) => (
                      <Col key={label} xs={24} sm={12} lg={8}><Card size="small" title={label}><strong style={{ fontSize: 24 }}>{value === null ? '—' : value.toLocaleString()}</strong></Card></Col>
                    ))}
                  </Row>
                ) : null}
                {result.kind === 'chart' && chartValues.length > 0 ? (
                  <div style={{ margin: '16px 0' }}>
                    {chartValues.map((group) => {
                      const value = chartMetric === undefined ? group.count : group.metrics[chartMetric] ?? 0;
                      const percent = Math.max(0, Math.min(100, Math.round((Math.abs(value) / chartMax) * 100)));
                      return <div key={group.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, 180px) 1fr auto', gap: 12, alignItems: 'center', margin: '8px 0' }}><span>{group.key}</span><Progress percent={percent} showInfo={false} /><span>{value.toLocaleString()}</span></div>;
                    })}
                  </div>
                ) : null}
                {tableColumns.length > 0 ? <Table<Record<string, unknown>> size="small" rowKey={result.rows !== undefined ? '__rowId' : 'key'} columns={tableColumns} dataSource={tableData} pagination={{ pageSize: 20 }} scroll={{ x: true }} /> : null}
              </>
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}
