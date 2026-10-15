import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { generateId } from "@carocrm/core/utils/id.js";
import { Inject, Injectable } from "@nestjs/common";

import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../../common/request-scope.js";
import { DatabaseService } from "../../database/database.service.js";
import { runInTransaction } from "../../entity/tx-context.js";
import {
  type AllocationTiming,
  DEFAULT_NUMBER_SERIES,
  formatDocumentNumber,
  type NumberSeriesSeed,
} from "./number-series-defaults.js";
import type { SalesAuditContext } from "./types.js";

/**
 * Phase 19-S.2 — commercial document numbering (PLAN_Phase_19_Sales.md §4.4, §8.3).
 *
 * Rules this service implements, and only these:
 *
 *  - a series is configured data (`sales_number_series`), never a hard-coded string in a controller;
 *  - allocation is atomic: the row is locked by `UPDATE … RETURNING`, so two concurrent issuances
 *    cannot receive the same number;
 *  - a number is never reused — the ledger row (`sales_document_numbers`) keeps the record even if
 *    the document is later voided, and `(series_id, number)` is unique;
 *  - issuing the *same document* twice returns the number it already has instead of taking a second
 *    one (the unique index on `(document_type, document_id)` is the backstop);
 *  - allocation timing is a policy on the series (`issuance` or `creation`), defaulting to
 *    issuance so an unsaved draft never consumes an official number (§4.7).
 *
 * Nothing here sends mail, prints a PDF or touches another module's tables.
 */

export type {
  AllocationTiming,
  NumberSeriesSeed,
} from "./number-series-defaults.js";
export {
  DEFAULT_NUMBER_SERIES,
  formatDocumentNumber,
} from "./number-series-defaults.js";

export interface NumberSeriesView {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly prefix: string;
  readonly padding: number;
  readonly nextNumber: number;
  readonly allocation: AllocationTiming;
  readonly active: boolean;
  readonly modifiedAt: Date;
  /** The number the next allocation would produce, without consuming it. */
  readonly nextPreview: string;
}

export interface NumberAllocation {
  readonly seriesId: string;
  readonly seriesCode: string;
  readonly number: number;
  readonly formatted: string;
  readonly documentType: string | null;
  readonly documentId: string | null;
  readonly allocatedAt: Date;
  /** True when an earlier call for the same document returned its existing number. */
  readonly reused: boolean;
}

export interface AllocateNumberInput {
  readonly documentType?: string | undefined;
  readonly documentId?: string | undefined;
  readonly audit?: SalesAuditContext | undefined;
}

const SERIES_CODE_PATTERN = /^[a-z][A-Za-z0-9]{0,40}$/;

@Injectable()
export class SalesNumberingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Every series with its unallocated next value — what the admin screen shows. */
  async list(): Promise<NumberSeriesView[]> {
    const rows = await this.database.db
      .selectFrom("sales_number_series")
      .selectAll()
      .orderBy("code", "asc")
      .execute();
    return rows.map((row) => this.toView(row));
  }

  /** The next number a series would produce, consuming nothing. */
  async preview(code: string): Promise<NumberSeriesView> {
    const row = await this.database.db
      .selectFrom("sales_number_series")
      .selectAll()
      .where("code", "=", requireSeriesCode(code))
      .executeTakeFirst();
    if (row === undefined)
      throw new NotFoundError(`Number series "${code}" does not exist.`);
    return this.toView(row);
  }

  /**
   * Allocate the next number from a series.
   *
   * Runs in one transaction: the series row is locked (`FOR UPDATE`), an existing allocation for
   * the same document is reused, and the incremented value plus its ledger row are written before
   * the lock is released. A unique-constraint race is a domain outcome the caller can retry, not a
   * silent success (PLAN_Phase_19_Sales.md §6.3).
   */
  async allocate(
    code: string,
    input: AllocateNumberInput = {},
  ): Promise<NumberAllocation> {
    const seriesCode = requireSeriesCode(code);
    const documentType = input.documentType?.trim();
    const documentId = input.documentId?.trim();
    if (
      (documentType === undefined || documentType === "") !==
      (documentId === undefined || documentId === "")
    ) {
      throw new ValidationError(
        "A document number allocation needs both `documentType` and `documentId`, or neither.",
        {
          documentType: input.documentType,
          documentId: input.documentId,
        },
      );
    }

    return runInTransaction(this.database.db, async (tx) => {
      const locked = await tx
        .selectFrom("sales_number_series")
        .selectAll()
        .where("code", "=", seriesCode)
        .forUpdate()
        .executeTakeFirst();
      if (locked === undefined)
        throw new NotFoundError(
          `Number series "${seriesCode}" does not exist.`,
        );
      if (!locked.active)
        throw new ValidationError(
          `Number series "${seriesCode}" is inactive.`,
          { code: seriesCode },
        );

      if (documentType !== undefined && documentId !== undefined) {
        const existing = await tx
          .selectFrom("sales_document_numbers")
          .selectAll()
          .where("document_type", "=", documentType)
          .where("document_id", "=", documentId)
          .executeTakeFirst();
        if (existing !== undefined) {
          return {
            seriesId: existing.series_id,
            seriesCode,
            number: existing.number,
            formatted: existing.formatted,
            documentType: existing.document_type,
            documentId: existing.document_id,
            allocatedAt: existing.allocated_at,
            reused: true,
          };
        }
      }

      const allocated = locked.next_number;
      await tx
        .updateTable("sales_number_series")
        .set({ next_number: allocated + 1, modified_at: new Date() })
        .where("id", "=", locked.id)
        .execute();
      const formatted = formatDocumentNumber(
        locked.prefix,
        allocated,
        locked.padding,
      );
      const allocatedAt = new Date();
      await tx
        .insertInto("sales_document_numbers")
        .values({
          id: `sdn_${generateId()}`,
          series_id: locked.id,
          number: allocated,
          formatted,
          document_type: documentType ?? null,
          document_id: documentId ?? null,
          allocated_by: input.audit?.userId ?? this.scope.userId ?? null,
          correlation_id: input.audit?.correlationId ?? null,
          allocated_at: allocatedAt,
        })
        .execute();
      return {
        seriesId: locked.id,
        seriesCode,
        number: allocated,
        formatted,
        documentType: documentType ?? null,
        documentId: documentId ?? null,
        allocatedAt,
        reused: false,
      };
    });
  }

  /**
   * Provision series rows (install/bootstrap). Idempotent: an existing code keeps its counter, its
   * prefix and its padding — a re-run never resets a sequence (PLAN_Phase_19_Sales.md §17.1).
   */
  async ensureSeries(
    series: readonly NumberSeriesSeed[] = DEFAULT_NUMBER_SERIES,
  ): Promise<number> {
    let created = 0;
    for (const entry of series) {
      const code = requireSeriesCode(entry.code);
      const prefix = entry.prefix.trim();
      const padding = entry.padding ?? 6;
      if (prefix.length > 16)
        throw new ValidationError(
          `A number series prefix must be at most 16 characters.`,
          { code },
        );
      if (!Number.isInteger(padding) || padding < 1 || padding > 12) {
        throw new ValidationError(
          "A number series padding must be an integer between 1 and 12.",
          { code, padding },
        );
      }
      const result = await this.database.db
        .insertInto("sales_number_series")
        .values({
          id: `sns_${code}`,
          code,
          label: entry.label,
          prefix,
          padding,
          next_number: 1,
          allocation: entry.allocation ?? "issuance",
          active: true,
          created_at: new Date(),
          modified_at: new Date(),
        })
        .onConflict((oc) => oc.column("code").doNothing())
        .executeTakeFirst();
      created += Number(result.numInsertedOrUpdatedRows ?? 0n);
    }
    return created;
  }

  private toView(row: {
    id: string;
    code: string;
    label: string;
    prefix: string;
    padding: number;
    next_number: number;
    allocation: string;
    active: boolean;
    modified_at: Date;
  }): NumberSeriesView {
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      prefix: row.prefix,
      padding: row.padding,
      nextNumber: row.next_number,
      allocation: row.allocation === "creation" ? "creation" : "issuance",
      active: row.active,
      modifiedAt: row.modified_at,
      nextPreview: formatDocumentNumber(
        row.prefix,
        row.next_number,
        row.padding,
      ),
    };
  }
}

function requireSeriesCode(code: string): string {
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!SERIES_CODE_PATTERN.test(trimmed)) {
    throw new ValidationError(
      "A number series code is 1–41 letters/digits starting with a letter.",
      { code },
    );
  }
  return trimmed;
}
