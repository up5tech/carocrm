import { BarChartOutlined, DeleteOutlined, DownloadOutlined, PlayCircleOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Col, Empty, Input, Popconfirm, Progress, Row, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import type { ReportDefinitionShape, ReportKind, ReportRow, ReportRunResult, ReportScheduleRow } from '../api/types.js';
import { DocsLink } from '../components/docs/DocsLink.js';
import { t } from '../state/i18n.js';
import { fieldLabel, navEntities, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';

interface FilterRow {
  field: string;
  operator: string;
  value: string;
}

function reportKinds(): { value: ReportKind; label: string }[] {
  return [
    { value: 'list', label: t('web.reports.kindList') },
    { value: 'summary', label: t('web.reports.kindSummary') },
    { value: 'grouped', label: t('web.reports.kindGrouped') },
    { value: 'chart', label: t('web.reports.kindChart') },
    { value: 'matrix', label: t('web.reports.kindMatrix') },
    { value: 'kpi', label: t('web.reports.kindKpi') },
  ];
}
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
  const [matrixColumnField, setMatrixColumnField] = useState('');
  const [grain, setGrain] = useState<'day' | 'month' | 'year'>('month');
  const [metricOperation, setMetricOperation] = useState<'count' | 'sum' | 'avg' | 'min' | 'max'>('count');
  const [metricField, setMetricField] = useState('');
  const [metricName, setMetricName] = useState('records');
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [result, setResult] = useState<ReportRunResult | null>(null);
  const [schedule, setSchedule] = useState<ReportScheduleRow | null>(null);
  const [scheduleCron, setScheduleCron] = useState('0 8 * * 1');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const entities = useMemo(() => navEntities(metadata.data, principal?.type), [metadata.data, principal?.type]);
  const selectedEntity = entities.find((item) => item.name === entityType);
  const activeReport = reports.find((item) => item.id === reportId);
  const canManageReport = activeReport !== undefined && (principal?.type === 'admin' || activeReport.userId === principal?.id);
  const fields = useMemo(() => {
    const direct = Object.entries(selectedEntity?.fields ?? {})
      .filter(([, field]) => SCALAR_TYPES.has(field.type))
      .map(([field, definition]) => ({ value: field, label: fieldLabel(field, definition, metadata.data), type: definition.type }));
    const related = Object.entries(selectedEntity?.fields ?? {})
      .filter(([, field]) => ['link', 'linkOne', 'foreign'].includes(field.type) && field.entityKey !== undefined)
      .flatMap(([linkField, linkDefinition]) => Object.entries(metadata.data?.[linkDefinition.entityKey ?? '']?.fields ?? {})
        .filter(([, field]) => SCALAR_TYPES.has(field.type))
        .map(([targetField, field]) => ({
          value: `${linkField}.${targetField}`,
          label: `${fieldLabel(linkField, linkDefinition, metadata.data)} · ${fieldLabel(targetField, field, metadata.data)}`,
          type: field.type,
        })));
    return [...direct, ...related];
  }, [metadata.data, selectedEntity]);
  const directFields = useMemo(() => fields.filter((field) => !field.value.includes('.')), [fields]);
  const fieldByName = useMemo(() => new Map(fields.map((field) => [field.value, field])), [fields]);
  const numericFields = fields.filter((field) => NUMERIC_TYPES.has(field.type));
  const groupFieldType = fieldByName.get(groupField)?.type;

  const load = useCallback(async () => {
    try {
      const items = await api.reports();
      setReports(items);
      setReportId((current) => (items.some((item) => item.id === current) ? current : null));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.reports.loadFailed'));
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
    setMatrixColumnField('');
    setMetricOperation('count');
    setMetricField('');
    setMetricName('records');
    setFilters([]);
    setVisibility('private');
    setResult(null);
    setSchedule(null);
    setScheduleCron('0 8 * * 1');
  }, []);

  const selectReport = useCallback((report: ReportRow) => {
    const definition = report.definition;
    setReportId(report.id);
    setName(report.name);
    setEntityType(definition.entityType);
    setKind(definition.kind);
    setColumns(definition.columns ?? []);
    setGroupField(definition.groupBy?.field ?? definition.matrix?.rows.field ?? '');
    setMatrixColumnField(definition.matrix?.columns.field ?? '');
    setGrain(definition.groupBy?.grain ?? definition.matrix?.rows.grain ?? definition.matrix?.columns.grain ?? 'month');
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
    setSchedule(null);
    void api.reportSchedule(report.id).then((current) => {
      setSchedule(current);
      if (current) setScheduleCron(current.cron);
    }).catch((error: unknown) => {
      void message.error(error instanceof Error ? error.message : t('web.reports.scheduleLoadFailed'));
    });
  }, [message]);

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
    if (kind === 'matrix' && groupField !== '' && matrixColumnField !== '') {
      const columnFieldType = fieldByName.get(matrixColumnField)?.type;
      next.matrix = {
        rows: { field: groupField, ...((groupFieldType === 'date' || groupFieldType === 'datetime') ? { grain } : {}) },
        columns: { field: matrixColumnField, ...((columnFieldType === 'date' || columnFieldType === 'datetime') ? { grain } : {}) },
      };
    }
    return next;
  }, [columns, entityType, fieldByName, filters, grain, groupField, groupFieldType, kind, matrixColumnField, metricField, metricName, metricOperation]);

  const runPreview = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.previewReport(definition());
      setResult(response.result);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.reports.previewFailed'));
    } finally {
      setLoading(false);
    }
  }, [definition, message]);

  const save = useCallback(async () => {
    if (name.trim() === '') {
      void message.warning(t('web.reports.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const input = { name: name.trim(), definition: definition(), visibility };
      const saved = reportId === null ? await api.createReport(input) : await api.updateReport(reportId, input);
      setReportId(saved.id);
      setName(saved.name);
      await load();
      void message.success(t('web.reports.saved'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.reports.saveFailed'));
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
      void message.error(error instanceof Error ? error.message : t('web.reports.runFailed'));
    } finally {
      setLoading(false);
    }
  }, [message, reportId, runPreview]);

  const exportCsv = useCallback(async () => {
    if (reportId === null) {
      void message.warning(t('web.reports.exportNeedsSave'));
      return;
    }
    try {
      const file = await api.exportReport(reportId);
      const url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoking synchronously can cancel the download in Chromium; release later.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      if (file.truncated) void message.warning(t('web.reports.exportTruncated', { rows: String(file.rows) }));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.reports.exportFailed'));
    }
  }, [message, reportId]);

  const saveSchedule = useCallback(async () => {
    if (reportId === null) {
      void message.warning(t('web.reports.scheduleNeedsSave'));
      return;
    }
    try {
      const updated = await api.saveReportSchedule(reportId, { cron: scheduleCron.trim(), enabled: true });
      setSchedule(updated);
      void message.success(t('web.reports.scheduleSaved'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.reports.scheduleSaveFailed'));
    }
  }, [message, reportId, scheduleCron]);

  const toggleSchedule = useCallback(async () => {
    if (reportId === null || schedule === null) return;
    try {
      const updated = await api.setReportScheduleEnabled(reportId, !schedule.enabled);
      setSchedule(updated);
      void message.success(updated.enabled ? t('web.reports.scheduleEnabled') : t('web.reports.schedulePaused'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.reports.scheduleUpdateFailed'));
    }
  }, [message, reportId, schedule]);

  const removeSchedule = useCallback(async () => {
    if (reportId === null || schedule === null) return;
    try {
      await api.deleteReportSchedule(reportId);
      setSchedule(null);
      void message.success(t('web.reports.scheduleRemoved'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.reports.scheduleRemoveFailed'));
    }
  }, [message, reportId, schedule]);

  const remove = useCallback(async () => {
    if (reportId === null) return;
    try {
      await api.deleteReport(reportId);
      resetBuilder();
      await load();
      void message.success(t('web.reports.deleted'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.reports.deleteFailed'));
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
    if (result.matrix !== undefined) {
      const metricNames = Object.keys(result.matrix.cells[0]?.metrics ?? {});
      return [
        { title: fieldLabel(result.matrix.rowField, selectedEntity?.fields[result.matrix.rowField], metadata.data), dataIndex: 'rowKey', key: 'rowKey' },
        { title: fieldLabel(result.matrix.columnField, selectedEntity?.fields[result.matrix.columnField], metadata.data), dataIndex: 'columnKey', key: 'columnKey' },
        { title: t('web.reports.records'), dataIndex: 'count', key: 'count' },
        ...metricNames.map((metric) => ({ title: metric, dataIndex: ['metrics', metric], key: metric })),
      ] as ColumnsType<Record<string, unknown>>;
    }
    if (result.groups !== undefined) {
      const metricNames = Object.keys(result.groups[0]?.metrics ?? result.metrics ?? {});
      return [
        { title: groupField === '' ? t('web.reports.group') : fieldLabel(groupField, selectedEntity?.fields[groupField], metadata.data), dataIndex: 'key', key: 'key' },
        { title: t('web.reports.records'), dataIndex: 'count', key: 'count' },
        ...metricNames.map((metric) => ({ title: metric, dataIndex: ['metrics', metric], key: metric })),
      ] as ColumnsType<Record<string, unknown>>;
    }
    return [];
  }, [groupField, metadata.data, result, selectedEntity]);

  const tableData = result?.rows ?? result?.groups?.map((group) => ({ key: group.key, count: group.count, metrics: group.metrics })) ?? result?.matrix?.cells.map((cell) => ({ ...cell, key: `${cell.rowKey}::${cell.columnKey}` })) ?? [];
  const chartValues = result?.groups ?? [];
  const chartMetric = Object.keys(chartValues[0]?.metrics ?? {})[0];
  const chartMax = chartMetric === undefined ? 0 : Math.max(1, ...chartValues.map((group) => Math.abs(group.metrics[chartMetric] ?? 0)));

  return (
    <>
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.reports.title')}</h1>
          <p className="carocrm-page-sub">{t('web.reports.subtitle')}</p>
        
          <DocsLink docKey="user/dashboards-and-reports" compact /></div>
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={resetBuilder}>{t('web.reports.new')}</Button>
          <Button icon={<PlayCircleOutlined />} loading={loading} onClick={() => void runSaved()}>{t('web.reports.runPreview')}</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>{t('web.common.save')}</Button>
          <Button icon={<DownloadOutlined />} aria-label={t('web.reports.exportCsv')} disabled={reportId === null} onClick={() => void exportCsv()}>{t('web.reports.csv')}</Button>
          {reportId !== null ? (
            <Popconfirm title={t('web.reports.deleteConfirm')} onConfirm={() => void remove()} okText={t('web.common.delete')}>
              <Button danger icon={<DeleteOutlined />} aria-label={t('web.reports.deleteReport')} />
            </Popconfirm>
          ) : null}
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={6}>
          <Card className="carocrm-card" title={t('web.reports.savedTitle')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {reports.map((report) => (
                <Button key={report.id} type={report.id === reportId ? 'primary' : 'default'} block onClick={() => selectReport(report)}>
                  {report.name}{report.isShared ? t('web.reports.sharedSuffix') : ''}
                </Button>
              ))}
              {reports.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('web.reports.noSaved')} /> : null}
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={18}>
          <Card className="carocrm-card" title={t('web.reports.builderTitle')} extra={reportId === null ? <Tag color="blue">{t('web.reports.unsaved')}</Tag> : <Tag>{reportId.slice(0, 8)}</Tag>}>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <label htmlFor="report-name">{t('web.reports.nameLabel')}</label>
                <Input id="report-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('web.reports.namePlaceholder')} />
              </Col>
              <Col xs={24} md={6}>
                <label htmlFor="report-entity">{t('web.reports.entityLabel')}</label>
                <Select id="report-entity" style={{ width: '100%' }} value={entityType || undefined} options={entities.map((entity) => ({ value: entity.name, label: entity.label }))} onChange={(value) => { setEntityType(value ?? ''); setColumns([]); setGroupField(''); setMatrixColumnField(''); setFilters([]); }} showSearch optionFilterProp="label" />
              </Col>
              <Col xs={24} md={6}>
                <label htmlFor="report-kind">{t('web.reports.typeLabel')}</label>
                <Select id="report-kind" style={{ width: '100%' }} value={kind} options={reportKinds()} onChange={(value) => setKind(value)} />
              </Col>
              <Col xs={24}>
                <label htmlFor="report-columns">{t('web.reports.columnsLabel')}</label>
                <Select id="report-columns" mode="multiple" style={{ width: '100%' }} value={columns} options={fields.map(({ value, label }) => ({ value, label }))} onChange={setColumns} disabled={kind !== 'list'} placeholder={t('web.reports.columnsPlaceholder')} />
              </Col>
              {(kind === 'grouped' || kind === 'chart' || kind === 'matrix') ? (
                <>
                  <Col xs={24} md={kind === 'matrix' ? 12 : 24}>
                    <label htmlFor="report-group">{kind === 'matrix' ? t('web.reports.rowDimension') : t('web.reports.groupBy')}</label>
                    <Select id="report-group" style={{ width: '100%' }} value={groupField || null} options={fields.map(({ value, label }) => ({ value, label }))} onChange={(value) => setGroupField(value ?? '')} showSearch optionFilterProp="label" placeholder={t('web.reports.chooseDimension')} />
                  </Col>
                  {kind === 'matrix' ? (
                    <Col xs={24} md={12}>
                      <label htmlFor="report-matrix-column">{t('web.reports.columnDimension')}</label>
                      <Select id="report-matrix-column" style={{ width: '100%' }} value={matrixColumnField || null} options={fields.map(({ value, label }) => ({ value, label }))} onChange={(value) => setMatrixColumnField(value ?? '')} showSearch optionFilterProp="label" placeholder={t('web.reports.chooseOtherDimension')} />
                    </Col>
                  ) : null}
                  {(groupFieldType === 'date' || groupFieldType === 'datetime' || (kind === 'matrix' && ['date', 'datetime'].includes(fieldByName.get(matrixColumnField)?.type ?? ''))) ? (
                    <Col xs={24} md={12}>
                      <label htmlFor="report-grain">{t('web.reports.grainLabel')}</label>
                      <Select id="report-grain" style={{ width: '100%' }} value={grain} options={[{ value: 'day', label: t('web.reports.grainDay') }, { value: 'month', label: t('web.reports.grainMonth') }, { value: 'year', label: t('web.reports.grainYear') }]} onChange={setGrain} />
                    </Col>
                  ) : null}
                </>
              ) : null}
              {kind !== 'list' ? (
                <>
                  <Col xs={24} md={8}>
                    <label htmlFor="report-metric-name">{t('web.reports.metricNameLabel')}</label>
                    <Input id="report-metric-name" value={metricName} onChange={(event) => setMetricName(event.target.value)} />
                  </Col>
                  <Col xs={24} md={8}>
                    <label htmlFor="report-metric-operation">{t('web.reports.aggregationLabel')}</label>
                    <Select id="report-metric-operation" style={{ width: '100%' }} value={metricOperation} options={[{ value: 'count', label: t('web.reports.aggCount') }, { value: 'sum', label: t('web.reports.aggSum') }, { value: 'avg', label: t('web.reports.aggAvg') }, { value: 'min', label: t('web.reports.aggMin') }, { value: 'max', label: t('web.reports.aggMax') }]} onChange={(value) => setMetricOperation(value)} />
                  </Col>
                  <Col xs={24} md={8}>
                    <label htmlFor="report-metric-field">{t('web.reports.metricFieldLabel')}</label>
                    <Select id="report-metric-field" style={{ width: '100%' }} value={metricField || null} options={numericFields.map(({ value, label }) => ({ value, label }))} onChange={(value) => setMetricField(value ?? '')} disabled={metricOperation === 'count'} placeholder={t('web.reports.chooseField')} />
                  </Col>
                </>
              ) : null}
              <Col xs={24}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                  <strong>{t('web.reports.filtersLabel')}</strong>
                  <Button size="small" onClick={() => setFilters((current) => [...current, { field: '', operator: 'equals', value: '' }])}>{t('web.reports.addFilter')}</Button>
                </Space>
                <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
                  {filters.map((filter, index) => (
                    <Space key={`filter-${String(index)}`} wrap>
                      <Select aria-label={t('web.reports.filterFieldAria', { index: String(index + 1) })} style={{ minWidth: 180 }} value={filter.field || undefined} options={directFields.map(({ value, label }) => ({ value, label }))} onChange={(value) => setFilters((current) => current.map((item, i) => i === index ? { ...item, field: value ?? '' } : item))} placeholder={t('web.reports.fieldPlaceholder')} />
                      <Select aria-label={t('web.reports.filterOperatorAria', { index: String(index + 1) })} style={{ width: 150 }} value={filter.operator} options={[{ value: 'equals', label: t('web.reports.opEquals') }, { value: 'notEquals', label: t('web.reports.opNotEquals') }, { value: 'contains', label: t('web.reports.opContains') }, { value: 'greaterThan', label: t('web.reports.opGreaterThan') }, { value: 'lessThan', label: t('web.reports.opLessThan') }, { value: 'isNull', label: t('web.reports.opIsEmpty') }, { value: 'isNotNull', label: t('web.reports.opIsNotEmpty') }]} onChange={(value) => setFilters((current) => current.map((item, i) => i === index ? { ...item, operator: value } : item))} />
                      <Input aria-label={t('web.reports.filterValueAria', { index: String(index + 1) })} style={{ width: 180 }} value={filter.value} disabled={filter.operator === 'isNull' || filter.operator === 'isNotNull'} onChange={(event) => setFilters((current) => current.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} placeholder={t('web.reports.valuePlaceholder')} />
                      <Button danger type="text" icon={<DeleteOutlined />} aria-label={t('web.reports.removeFilterAria', { index: String(index + 1) })} onClick={() => setFilters((current) => current.filter((_, i) => i !== index))} />
                    </Space>
                  ))}
                </Space>
              </Col>
              <Col xs={24} md={12}>
                <label htmlFor="report-visibility">{t('web.reports.visibilityLabel')}</label>
                <Select id="report-visibility" style={{ width: '100%' }} value={visibility} options={[{ value: 'private', label: t('web.reports.visibilityPrivate') }, { value: 'shared', label: t('web.reports.visibilityShared') }]} onChange={setVisibility} />
              </Col>
              {reportId !== null && canManageReport ? (
                <Col xs={24}>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <strong>{t('web.reports.scheduleTitle')}</strong>
                    <Space wrap>
                      <Input aria-label={t('web.reports.scheduleCronAria')} value={scheduleCron} onChange={(event) => setScheduleCron(event.target.value)} style={{ width: 220 }} placeholder="0 8 * * 1" />
                      <Button onClick={() => void saveSchedule()}>{schedule ? t('web.reports.scheduleUpdate') : t('web.reports.scheduleCreate')}</Button>
                      {schedule ? <Tag color={schedule.enabled ? 'green' : 'default'}>{schedule.enabled ? t('web.reports.scheduleEnabledTag', { cron: schedule.cron }) : t('web.reports.schedulePausedTag', { cron: schedule.cron })}</Tag> : null}
                      {schedule ? <Button onClick={() => void toggleSchedule()}>{schedule.enabled ? t('web.reports.schedulePause') : t('web.reports.scheduleEnable')}</Button> : null}
                      {schedule ? <Button danger onClick={() => void removeSchedule()}>{t('web.reports.scheduleRemove')}</Button> : null}
                    </Space>
                    <span style={{ color: '#737b85' }}>{t('web.reports.scheduleHint')}</span>
                  </Space>
                </Col>
              ) : null}
            </Row>
          </Card>

          <Card className="carocrm-card" title={<Space><BarChartOutlined />{t('web.reports.resultsTitle')}</Space>} style={{ marginTop: 16 }}>
            {!result ? <Empty description={t('web.reports.resultsEmpty')} /> : (
              <>
                {result.truncated ? <Alert type="warning" showIcon message={t('web.reports.partialResult', { scanned: String(result.scanned), total: String(result.total) })} style={{ marginBottom: 16 }} /> : null}
                <Space style={{ marginBottom: 12 }} wrap>
                  <Tag>{t('web.reports.matchingRecords', { total: String(result.total) })}</Tag>
                  <Tag color={result.truncated ? 'orange' : 'green'}>{result.truncated ? t('web.reports.scannedPartial', { scanned: String(result.scanned) }) : result.scanned === null ? t('web.reports.exactAggregate') : t('web.reports.scanned', { scanned: String(result.scanned) })}</Tag>
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
