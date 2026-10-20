import type { ConnectorCredential } from '../../connector-adapter.port.js';

/**
 * Phase 19-INT.24 — the bounded enrichment provider interface
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.9; `19-INT.24`).
 *
 * The plan asks for *"a bounded adapter pattern for one selected enrichment provider at a time"*.
 * This is that pattern, and "bounded" is the whole point:
 *
 *  - the provider is asked for **specific fields**, never for "enrich this record";
 *  - the provider is given **only the fields the profile opted in**, so a provider never receives
 *    data the administrator did not choose to share;
 *  - the provider answers with **values only** — it never writes, never creates and never deletes;
 *  - the provider reports **what it cost**, so the platform can keep a quota.
 *
 * The enrichment provider is deliberately **not** the same thing as a sync connector. A connector
 * moves records; an enrichment provider answers a question about one record and hands the answer
 * to a human, who decides.
 */

/** What the provider is asked. */
export interface EnrichmentRequest {
  /** The CRM entity the record belongs to. */
  readonly entityType: string;
  /** The CRM record's id. */
  readonly recordId: string;
  /** The values the provider may use, already reduced to the opted-in fields. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** What the provider answered. */
export interface EnrichmentOutcome {
  /**
   * The values the provider returned, keyed by the **CRM field name** they belong to.
   *
   * The provider does the mapping, so a provider cannot introduce a field the administrator did
   * not opt in to: whatever the provider answers is already reduced to the CRM's vocabulary.
   */
  readonly fields: Readonly<Record<string, unknown>>;
  /**
   * The provider's confidence per field, when it publishes a meaningful one.
   *
   * A provider that does not publish a confidence returns nothing — a fabricated number would be
   * worse than no number at all.
   */
  readonly confidence: Readonly<Record<string, number>>;
  /** What the call cost, in the provider's own credit unit. */
  readonly creditsUsed: number;
  /** A non-secret reference to the provider's own answer, for reconciliation. */
  readonly providerRef: string | null;
}

/** What the provider needs to answer. */
export interface EnrichmentContext {
  readonly connectionId: string;
  readonly credential: ConnectorCredential;
  /** The profile's non-secret configuration. */
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * An enrichment provider.
 *
 * The interface is deliberately tiny: one method. A provider that needs more than that is not an
 * enrichment provider.
 */
export interface EnrichmentAdapter {
  readonly providerKey: string;
  readonly adapterVersion: string;
  /** The greatest number of fields one request may carry. */
  readonly maxFieldsPerRequest: number;
  /**
   * Check the provider's configuration.
   *
   * The service calls it before a profile is stored, so a profile whose configuration cannot work
   * never exists. The provider owns the shape of its own configuration.
   */
  validateOptions?(options: Readonly<Record<string, unknown>>): void;
  /** Answer one request. */
  enrich(context: EnrichmentContext, request: EnrichmentRequest): Promise<EnrichmentOutcome>;
}
