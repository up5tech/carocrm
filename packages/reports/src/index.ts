import { z } from 'zod';

export const REPORT_KINDS = ['list', 'summary', 'grouped', 'chart', 'kpi'] as const;
export const REPORT_AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export const REPORT_CALCULATIONS = ['add', 'subtract', 'multiply', 'divide', 'percentOf'] as const;
export const REPORT_DATE_GRAINS = ['day', 'month', 'year'] as const;
export const MAX_REPORT_COLUMNS = 24;
export const MAX_REPORT_FILTERS = 30;
export const MAX_REPORT_METRICS = 8;
export const MAX_REPORT_GROUPS = 100;
export const MAX_REPORT_SCAN = 2_000;
export const REPORT_PAGE_SIZE = 500;

const fieldName = z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const metricName = z.string().trim().min(1).max(32).regex(/^[A-Za-z][A-Za-z0-9_]*$/);

const MetricSchema = z.object({
  name: metricName,
  operation: z.enum(REPORT_AGGREGATIONS),
  field: fieldName.optional(),
}).strict().superRefine((metric, context) => {
  if (metric.operation === 'count' && metric.field !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Count metrics count records and must not specify a field.', path: ['field'] });
  }
  if (metric.operation !== 'count' && metric.field === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${metric.operation} metrics require a field.`, path: ['field'] });
  }
});

const CalculationSchema = z.object({
  name: metricName,
  operation: z.enum(REPORT_CALCULATIONS),
  left: metricName,
  right: metricName,
}).strict();

export const ReportDefinitionSchema = z.object({
  version: z.literal(1).default(1),
  entityType: z.string().trim().min(2).max(50).regex(/^[A-Z][A-Za-z0-9]{1,49}$/),
  kind: z.enum(REPORT_KINDS),
  filters: z.array(z.unknown()).max(MAX_REPORT_FILTERS).default([]),
  columns: z.array(fieldName).max(MAX_REPORT_COLUMNS).default([]),
  groupBy: z.object({ field: fieldName, grain: z.enum(REPORT_DATE_GRAINS).optional() }).strict().optional(),
  metrics: z.array(MetricSchema).max(MAX_REPORT_METRICS).default([]),
  calculatedMetrics: z.array(CalculationSchema).max(MAX_REPORT_METRICS).default([]),
}).strict().superRefine((definition, context) => {
  if (definition.kind === 'list' && definition.columns.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'List reports need at least one column.', path: ['columns'] });
  }
  if (definition.kind === 'list' && definition.groupBy !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'List reports cannot group rows.', path: ['groupBy'] });
  }
  if (definition.kind === 'list' && (definition.metrics.length > 0 || definition.calculatedMetrics.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'List reports cannot declare metrics.', path: ['metrics'] });
  }
  if ((definition.kind === 'summary' || definition.kind === 'kpi') && definition.groupBy !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${definition.kind} reports cannot group rows.`, path: ['groupBy'] });
  }
  if ((definition.kind === 'grouped' || definition.kind === 'chart') && definition.groupBy === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${definition.kind} reports need a grouping field.`, path: ['groupBy'] });
  }
  if (definition.kind !== 'list' && definition.metrics.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${definition.kind} reports need at least one metric.`, path: ['metrics'] });
  }
  const names = new Set<string>();
  for (const [index, metric] of definition.metrics.entries()) {
    if (names.has(metric.name)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate metric name "${metric.name}".`, path: ['metrics', index, 'name'] });
    names.add(metric.name);
  }
  for (const [index, calculation] of definition.calculatedMetrics.entries()) {
    if (names.has(calculation.name)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate metric name "${calculation.name}".`, path: ['calculatedMetrics', index, 'name'] });
    if (!names.has(calculation.left) || !names.has(calculation.right)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Calculated metrics may only use metrics declared before them.', path: ['calculatedMetrics', index] });
    }
    names.add(calculation.name);
  }
});

export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportAggregation = (typeof REPORT_AGGREGATIONS)[number];
export type ReportCalculation = (typeof REPORT_CALCULATIONS)[number];
export type ReportDateGrain = (typeof REPORT_DATE_GRAINS)[number];
export type ReportMetric = z.infer<typeof MetricSchema>;
export type ReportCalculationDefinition = z.infer<typeof CalculationSchema>;
export type ReportDefinition = z.infer<typeof ReportDefinitionSchema>;

export interface ReportFieldShape {
  readonly type: string;
}

const SYSTEM_FIELDS: Readonly<Record<string, string>> = {
  id: 'varchar',
  name: 'varchar',
  createdAt: 'datetime',
  modifiedAt: 'datetime',
  assignedUserId: 'varchar',
  createdById: 'varchar',
  modifiedById: 'varchar',
  deletedAt: 'datetime',
  version: 'int',
  teams: 'multiEnum',
};

const REPORTABLE_TYPES: ReadonlySet<string> = new Set([
  'varchar', 'text', 'email', 'phone', 'url', 'enum', 'multiEnum', 'bool',
  'int', 'float', 'decimal', 'currency', 'date', 'datetime',
]);
const NUMERIC_TYPES: ReadonlySet<string> = new Set(['int', 'float', 'decimal', 'currency']);

/** Validate field existence and type semantics against the current entity metadata. */
export function validateReportDefinition(
  raw: unknown,
  fields: Readonly<Record<string, ReportFieldShape>>,
): ReportDefinition {
  const definition = ReportDefinitionSchema.parse(raw);
  const typeOf = (name: string): string | undefined => fields[name]?.type ?? SYSTEM_FIELDS[name];
  const requireField = (name: string, purpose: string): string => {
    const type = typeOf(name);
    if (type === undefined || !REPORTABLE_TYPES.has(type)) {
      throw new Error(`Field "${name}" is not available for ${purpose}.`);
    }
    return type;
  };

  for (const name of definition.columns) requireField(name, 'report columns');
  if (definition.groupBy !== undefined) {
    const type = requireField(definition.groupBy.field, 'grouping');
    if ((type === 'date' || type === 'datetime') && definition.groupBy.grain === undefined) {
      throw new Error(`Date grouping field "${definition.groupBy.field}" needs a day, month or year grain.`);
    }
    if (type !== 'date' && type !== 'datetime' && definition.groupBy.grain !== undefined) {
      throw new Error(`A date grain can only be used with a date field ("${definition.groupBy.field}").`);
    }
  }
  for (const metric of definition.metrics) {
    if (metric.field === undefined) continue;
    const type = requireField(metric.field, 'metrics');
    if (!NUMERIC_TYPES.has(type)) throw new Error(`Metric field "${metric.field}" must be numeric.`);
  }
  return definition;
}

export interface ReportGroup {
  readonly key: string;
  readonly count: number;
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface ReportResult {
  readonly entityType: string;
  readonly kind: ReportKind;
  readonly scanned: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly columns?: readonly string[];
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  readonly metrics?: Readonly<Record<string, number | null>>;
  readonly groups?: readonly ReportGroup[];
}

/** Apply saved, validated metrics to the bounded rows returned through EntityCrudService. */
export function executeReport(
  definition: ReportDefinition,
  records: readonly Readonly<Record<string, unknown>>[],
  total: number,
): ReportResult {
  const base = {
    entityType: definition.entityType,
    kind: definition.kind,
    scanned: records.length,
    total,
    truncated: total > records.length,
  } as const;

  if (definition.kind === 'list') {
    const rows = records.map((record, index) => {
      const row: Record<string, unknown> = { __rowId: String(record['id'] ?? index) };
      for (const column of definition.columns) row[column] = record[column] ?? null;
      return row;
    });
    return { ...base, columns: definition.columns, rows };
  }

  if (definition.kind === 'summary' || definition.kind === 'kpi') {
    return { ...base, metrics: calculateMetrics(definition, records) };
  }

  const group = definition.groupBy;
  if (group === undefined) return { ...base, groups: [] };
  const buckets = new Map<string, Readonly<Record<string, unknown>>[]>();
  let omittedGroups = false;
  for (const record of records) {
    const key = groupKey(record[group.field], group.grain);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      if (buckets.size >= MAX_REPORT_GROUPS) {
        omittedGroups = true;
        continue;
      }
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(record);
  }
  const groups = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([key, rows]) => ({ key, count: rows.length, metrics: calculateMetrics(definition, rows) }));
  return { ...base, truncated: base.truncated || omittedGroups, groups };
}

function calculateMetrics(definition: ReportDefinition, rows: readonly Readonly<Record<string, unknown>>[]): Record<string, number | null> {
  const values: Record<string, number | null> = {};
  for (const metric of definition.metrics) {
    if (metric.operation === 'count') {
      values[metric.name] = rows.length;
      continue;
    }
    const samples = rows.map((row) => toFiniteNumber(row[metric.field ?? ''])).filter((value): value is number => value !== null);
    const sum = finiteSum(samples);
    if (metric.operation === 'sum') values[metric.name] = sum;
    else if (metric.operation === 'avg') values[metric.name] = samples.length === 0 || sum === null ? null : sum / samples.length;
    else if (metric.operation === 'min') values[metric.name] = samples.length === 0 ? null : Math.min(...samples);
    else values[metric.name] = samples.length === 0 ? null : Math.max(...samples);
  }
  for (const calculation of definition.calculatedMetrics) {
    const left = values[calculation.left];
    const right = values[calculation.right];
    values[calculation.name] = calculate(calculation.operation, left, right);
  }
  return values;
}

function calculate(operation: ReportCalculation, left: number | null | undefined, right: number | null | undefined): number | null {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  let value: number;
  if (operation === 'add') value = left + right;
  else if (operation === 'subtract') value = left - right;
  else if (operation === 'multiply') value = left * right;
  else if (operation === 'divide') value = right === 0 ? Number.NaN : left / right;
  else value = right === 0 ? Number.NaN : (left / right) * 100;
  return Number.isFinite(value) ? value : null;
}

function finiteSum(values: readonly number[]): number | null {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isFinite(sum)) return null;
  }
  return sum;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function groupKey(value: unknown, grain?: ReportDateGrain): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (grain !== undefined) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return '(empty)';
    const year = String(date.getUTCFullYear()).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    if (grain === 'year') return year;
    if (grain === 'month') return `${year}-${month}`;
    return `${year}-${month}-${day}`;
  }
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : '(empty)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).slice(0, 120);
}
