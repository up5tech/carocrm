import { Injectable } from '@nestjs/common';

/**
 * Phase 19-INT.25 — the cross-module integration contracts
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.2, §19 `19-INT.25`).
 *
 * A connector changes CRM data, and CRM data is **owned by a domain module**. The plan is
 * unambiguous: *"Invoke the owning domain service or approved internal integration contract"* and
 * *"Do not allow imported payload fields to assign owners, teams, permissions, roles, payment
 * status, consent, or other protected values unless an explicit reviewed mapping and owning-service
 * policy permits it."*
 *
 * So the integration module does not reach into a domain module's tables, and it does not
 * re-implement a domain rule. It **calls a contract** — a named, versioned, published operation
 * with an owner — and the owner keeps its rules.
 *
 * Three properties make this work:
 *
 *  1. **The contract names its owner.** Every contract says which module owns the behaviour and
 *     what it owns, so an auditor can answer "who is allowed to change this?" without reading the
 *     implementation.
 *  2. **The contract is optional.** A domain module that is not installed publishes no contract.
 *     The integration module then reports the contract as **unavailable** rather than pretending
 *     to own the behaviour. This is what makes the integrations "optional and isolated": a
 *     deployment without `Sales` still runs every other connector, and a Stripe delivery is
 *     recorded as a receipt rather than crashing a worker.
 *  3. **The contract is versioned.** A consumer states the version it was written against, so a
 *     change to a contract's shape is a deliberate act rather than a surprise.
 *
 * The registry is the only place a contract is looked up. A connector never imports a domain
 * service.
 */

/**
 * The contract keys this module knows about.
 *
 * Every key a module publishes must be listed here: `knownKeys()` is what the diagnostics and the
 * admin UI compare against, so a published contract that is missing here is a contract the platform
 * cannot account for.
 */
export const INTEGRATION_CONTRACT_KEYS = [
  'sales.payment.providerEvent',
  'sales.accounting.export',
  'sales.customer.summary',
  'marketing.consent.providerSuppression',
  'marketing.consent.providerDecision',
  'customerSuccess.profile.ensure',
  'projects.task.create',
  'serviceDesk.case.transition',
  'voiceCommunications.consent.suppress',
  'voiceCommunications.inbox.read',
  'voiceCommunications.message.send',
] as const;

export type IntegrationContractKey = (typeof INTEGRATION_CONTRACT_KEYS)[number];

/**
 * A published, versioned operation a domain module owns.
 *
 * The input and the output are the contract's own types; the integration module never reaches
 * past them.
 */
export interface IntegrationContract<TInput extends object, TOutput extends object> {
  /** The stable key a consumer looks the contract up by. */
  readonly contractKey: string;
  /** The version the contract is published at. */
  readonly contractVersion: number;
  /** The module that owns the behaviour. */
  readonly owningModule: string;
  /** What the owner keeps. Spelled out, because "who owns this?" is the question an audit asks. */
  readonly ownership: string;
  /** Run the contract. */
  apply(input: TInput): Promise<IntegrationContractResult<TOutput>>;
}

/** A CRM record a contract changed. */
export interface AffectedRecord {
  readonly entityType: string;
  readonly entityId: string;
}

/**
 * What a contract produced.
 *
 * The `affectedRecords` are how the **event loop is prevented**. A contract that changes a CRM
 * record — a payment request that became `paid`, a case that was resolved — produces a domain
 * event like any other change. Without the affected records, the outbound path would treat it as
 * a user edit and push the record back to the provider, which would report the change again, and
 * the platform would push it again, forever.
 *
 * So a contract names what it touched, and the integration module records the **origin** of those
 * records. The outbound path then recognises the change as the provider's own and skips it — the
 * same guard an inbound sync uses.
 */
export interface IntegrationContractResult<TOutput extends object> {
  readonly value: TOutput;
  readonly affectedRecords: readonly AffectedRecord[];
}

/** A contract without its types, for the registry and the diagnostics. */
export interface IntegrationContractDescriptor {
  readonly contractKey: string;
  readonly contractVersion: number;
  readonly owningModule: string;
  readonly ownership: string;
}

/** The outcome of a contract call. */
export interface ContractOutcome<TOutput extends object> {
  readonly contractKey: string;
  readonly contractVersion: number;
  readonly owningModule: string;
  readonly value: TOutput;
  /** The CRM records the contract changed. */
  readonly affectedRecords: readonly AffectedRecord[];
}

/**
 * The registry of published contracts.
 *
 * A contract is registered by the module that owns it. The integration module only ever looks one
 * up.
 */
@Injectable()
export class IntegrationContractRegistry {
  private readonly contracts = new Map<string, IntegrationContract<never, never>>();

  /**
   * Publish a contract.
   *
   * A second publication of the same key replaces the first, so a re-registration during a test
   * or a hot reload does not fail.
   */
  register<TInput extends object, TOutput extends object>(
    contract: IntegrationContract<TInput, TOutput>,
  ): void {
    this.contracts.set(
      contract.contractKey,
      contract as unknown as IntegrationContract<never, never>,
    );
  }

  /** The contract for a key, or `undefined` when the owning module is not installed. */
  find<TInput extends object, TOutput extends object>(
    contractKey: string,
  ): IntegrationContract<TInput, TOutput> | undefined {
    return this.contracts.get(contractKey) as unknown as
      | IntegrationContract<TInput, TOutput>
      | undefined;
  }

  /** Every published contract, as a descriptor. */
  all(): readonly IntegrationContractDescriptor[] {
    return [...this.contracts.values()]
      .map((contract) => ({
        contractKey: contract.contractKey,
        contractVersion: contract.contractVersion,
        owningModule: contract.owningModule,
        ownership: contract.ownership,
      }))
      .sort((left, right) => left.contractKey.localeCompare(right.contractKey));
  }

  /** Every known contract key, whether or not it is published. */
  knownKeys(): readonly string[] {
    return [...INTEGRATION_CONTRACT_KEYS];
  }

  /**
   * Call a contract.
   *
   * A contract that nobody published is a **refusal**, not a silent success: the caller is told
   * that the owning module is not available, so it can record the event and leave the decision to
   * an operator.
   */
  async apply<TInput extends object, TOutput extends object>(
    contractKey: string,
    input: TInput,
  ): Promise<ContractOutcome<TOutput> | null> {
    const contract = this.find<TInput, TOutput>(contractKey);
    if (contract === undefined) return null;
    const result = await contract.apply(input);
    return {
      contractKey: contract.contractKey,
      contractVersion: contract.contractVersion,
      owningModule: contract.owningModule,
      value: result.value,
      affectedRecords: result.affectedRecords,
    };
  }
}
