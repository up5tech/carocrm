import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import type { FieldDefinition } from '@carocrm/metadata/schemas/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import type { ListQuery } from '../entity/entity.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { csvCell, parseCsv, toCsvText } from './csv.js';
import type { ImportResult } from './portal-shapes.js';
import { ENTITY_NAME, EXPORT_PAGE_SIZE, IMPORTABLE_TYPES, MAX_EXPORT_ROWS, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, NON_EXPORTABLE_TYPES } from './portal-shapes.js';

function coerceCell(def: FieldDefinition, raw: string): unknown {
  const text = raw.trim();
  if (text === '') return null;
  switch (def.type) {
    case 'bool':
      if (/^(true|1|yes|y)$/i.test(text)) return true;
      if (/^(false|0|no|n)$/i.test(text)) return false;
      throw new ValidationError(`Invalid boolean "${raw}".`);
    case 'int': {
      const num = Number(text);
      if (!Number.isInteger(num)) throw new ValidationError(`Invalid integer "${raw}".`);
      return num;
    }
    case 'float': case 'decimal': case 'currency': {
      const num = Number(text);
      if (Number.isNaN(num)) throw new ValidationError(`Invalid number "${raw}".`);
      return num;
    }
    case 'date': case 'datetime': {
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) throw new ValidationError(`Invalid date "${raw}".`);
      return date.toISOString();
    }
    case 'multiEnum':
      return text.split(/[,;|]/).map((i) => i.trim()).filter((i) => i !== '');
    default:
      return raw;
  }
}
@Injectable()
export class ImportExportService {
  constructor(@Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(AclApiService) private readonly acl: AclApiService) {}
  assertEntity(entity: string): void {
    this.metadata.ensureLoaded();
    if (!ENTITY_NAME.test(entity) || !this.metadata.registry.hasEntity(entity)) throw new NotFoundError(`Entity "${entity}" does not exist.`);
  }
  exportableFields(entity: string): { name: string; type: string }[] {
    const fields = this.metadata.registry.getFields(entity);
    return Object.entries(fields)
      .filter(([name, def]) => !NON_EXPORTABLE_TYPES.has(def.type) && !['id','createdAt','modifiedAt','createdById','modifiedById','deletedAt'].includes(name))
      .map(([name, def]) => ({ name, type: def.type }));
  }
  async importCsv(entity: string, csv: string | Buffer, options: { updateOnName?: boolean } = {}): Promise<ImportResult> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'create');
    const text = typeof csv === 'string' ? csv : csv.toString('utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_IMPORT_BYTES) throw new ValidationError(`CSV is too large (${String(bytes)} bytes; max ${String(MAX_IMPORT_BYTES)}).`);
    const { headers, rows } = parseCsv(text);
    if (headers.length === 0) throw new ValidationError('CSV must carry a header row.');
    if (rows.length > MAX_IMPORT_ROWS) throw new ValidationError(`CSV carries ${String(rows.length)} rows; max ${String(MAX_IMPORT_ROWS)} per import.`);
    const fields = this.metadata.registry.getFields(entity);
    const columns = headers.map((h) => {
      const name = h.trim();
      if (name === '' || name === 'id') return name;
      const def = fields[name];
      if (!def) throw new ValidationError(`Unknown field "${name}" for entity "${entity}".`);
      if (!IMPORTABLE_TYPES.has(def.type)) throw new ValidationError(`Field "${name}" of type "${def.type}" cannot be imported.`);
      return name;
    });
    const result: ImportResult = { entity, created: 0, updated: 0, skipped: 0, errors: [], ids: [] };
    let rowNumber = 1;
    for (const row of rows) {
      rowNumber += 1;
      try {
        const data: Record<string, unknown> = {};
        columns.forEach((column, index) => {
          if (column === '') return;
          const cell = row[index] ?? '';
          if (column === 'id') { if (cell.trim() !== '') data['id'] = cell.trim(); return; }
          const def = fields[column];
          if (!def) return;
          const coerced = coerceCell(def, cell);
          if (coerced !== null) data[column] = coerced;
        });
        const id = typeof data['id'] === 'string' ? (data['id'] as string) : undefined;
        if (id) {
          delete data['id'];
          try {
            const updated = await this.entities.update(entity, id, data);
            result.updated += 1;
            result.ids.push(String(updated['id']));
          } catch (error: unknown) {
            if (error instanceof NotFoundError) {
              const created = await this.entities.create(entity, data);
              result.created += 1;
              result.ids.push(String(created['id']));
            } else throw error;
          }
          continue;
        }
        if (options.updateOnName && typeof data['name'] === 'string' && data['name'] !== '') {
          const existing = await this.entities.list(entity, { where: [{ field: 'name', operator: 'equals', value: data['name'] }], maxSize: 1, total: false });
          const first = existing.list[0] as Record<string, unknown> | undefined;
          if (first && typeof first['id'] === 'string') {
            const updated = await this.entities.update(entity, String(first['id']), data);
            result.updated += 1;
            result.ids.push(String(updated['id']));
            continue;
          }
        }
        const created = await this.entities.create(entity, data);
        result.created += 1;
        result.ids.push(String(created['id']));
      } catch (error: unknown) {
        result.skipped += 1;
        result.errors.push({ row: rowNumber, message: error instanceof Error ? error.message : String(error) });
        if (result.errors.length > 50) break;
      }
    }
    return result;
  }
  async exportCsv(entity: string, query: ListQuery = {}): Promise<{ entity: string; filename: string; csv: string; count: number }> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'read');
    const columns = this.exportableFields(entity).map((e) => e.name);
    // The Query Engine clamps one page to MAX_MAX_SIZE rows, so paging is what makes an export of a
    // 10k-record list actually complete instead of silently truncated at the first page.
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += EXPORT_PAGE_SIZE) {
      const page = await this.entities.list(entity, { ...query, select: columns.join(','), offset, maxSize: EXPORT_PAGE_SIZE, total: false });
      rows.push(...page.list);
      if (page.list.length < EXPORT_PAGE_SIZE) break;
    }
    const lines = [columns.map(csvCell).join(',')];
    for (const record of rows) lines.push(columns.map((c) => csvCell(toCsvText(record[c]))).join(','));
    const safe = entity.replace(/[^A-Za-z0-9_-]/g, '');
    return { entity, filename: `${safe || 'export'}-${new Date().toISOString().slice(0, 10)}.csv`, csv: `${lines.join('\r\n')}\r\n`, count: rows.length };
  }
}
