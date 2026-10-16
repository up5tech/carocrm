/**
 * Phase 19-S.1 — the `sales` module descriptor.
 *
 * The repository's Phase 19 domains are kernel-domain directories with a barrel
 * (`apps/api/src/projects`, and this module), not installable extension packages: the extension SDK
 * deliberately exposes no entity CRUD facade, so a package that owned Product/PriceBook records
 * could only write them with raw SQL, bypassing audit, stream, validation and domain events
 * (AGENTS.md §5.2). The audit in `docs/implementation/sales-repository-audit.md` §7 records that
 * decision and how the module identity is still explicit.
 *
 * This descriptor is that identity: a stable id, a version, the platform capabilities it builds on,
 * the optional modules it can talk to, and its feature flags with the settings path that controls
 * each one. The health endpoint reports it, so an operator can see *what* is installed and *what is
 * missing*, not just that the route answered.
 */

export interface SalesFeatureDescriptor {
  readonly key: string;
  readonly label: string;
  readonly settingsPath: string;
  /** What the feature depends on, for the health report. */
  readonly requires: readonly string[];
}

export interface SalesOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  /**
   * The metadata marker an optional module registers when it is installed. Detection reads the
   * metadata registry rather than importing the other module, so absence can never break startup
   * (PLAN_Phase_19_Sales.md §3.3).
   */
  readonly markerEntity: string;
}

/**
 * How one kernel capability is proven present. Every kind is read from a fact the running platform
 * can be asked about — never a hard-coded `true`:
 *
 *  - `entity`  the metadata registry has the entity registered (so the Entity Engine serves it)
 *  - `table`   the owning table exists in the current schema
 *  - `column`  the owning `table.column` exists (a table alone does not prove field granularity)
 *  - `hookPhase` the hook registry dispatches the phase
 */
export type PlatformEvidenceKind = "entity" | "table" | "column" | "hookPhase";

export interface PlatformEvidence {
  readonly kind: PlatformEvidenceKind;
  readonly value: string;
}

export interface SalesPlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly PlatformEvidence[];
}

/**
 * Kernel capabilities this module builds on; every one of them ships with the platform.
 *
 * The evidence names are deliberately narrow, and the health endpoint checks each one against the
 * platform's own state. `User`/`Team` are *not* metadata entities (identity lives in its own
 * tables), so a capability that needs them names the table it actually reads.
 */
export const REQUIRED_PLATFORM_CAPABILITIES: readonly SalesPlatformCapability[] =
  [
    {
      id: "entity-engine",
      label: "Entity Engine (metadata-driven records)",
      evidence: [
        { kind: "entity", value: "Account" },
        { kind: "table", value: "entity_records" },
      ],
    },
    {
      id: "crm-core-records",
      label: "CRM core records",
      evidence: [
        { kind: "entity", value: "Account" },
        { kind: "entity", value: "Contact" },
        { kind: "entity", value: "Opportunity" },
        { kind: "table", value: "users" },
        { kind: "table", value: "teams" },
      ],
    },
    {
      id: "acl",
      label: "ACL (roles and field permissions)",
      evidence: [
        { kind: "table", value: "roles" },
        { kind: "table", value: "users_roles" },
        { kind: "column", value: "roles.field_permissions" },
      ],
    },
    {
      id: "hooks",
      label: "Hook registry",
      evidence: [
        { kind: "hookPhase", value: "beforeValidate" },
        { kind: "hookPhase", value: "afterSave" },
      ],
    },
    {
      id: "audit-stream",
      label: "Audit log and stream",
      evidence: [
        { kind: "table", value: "audit_log" },
        { kind: "table", value: "stream_items" },
        { kind: "table", value: "outbox_events" },
      ],
    },
    {
      id: "jobs",
      label: "Background jobs",
      evidence: [
        { kind: "table", value: "jobs" },
        { kind: "table", value: "scheduled_jobs" },
        { kind: "table", value: "job_logs" },
      ],
    },
    {
      id: "inventory-ledger",
      label: "Inventory ledger projection",
      // 19-S.14: the lockable projection the availability and reservation rules read. Its absence is
      // reported rather than fatal — inventory is off by default, and every other Sales flow works.
      evidence: [{ kind: "table", value: "sales_inventory_stock" }],
    },
  ];

export const OPTIONAL_INTEGRATIONS: readonly SalesOptionalIntegration[] = [
  {
    id: "stripe-integration",
    label: "Stripe payments",
    provides: "Provider payment events and payment requests",
    markerEntity: "PaymentProviderEvent",
  },
  {
    id: "accounting-integration",
    label: "Accounting",
    provides: "Ledger export of invoices, payments and credits",
    markerEntity: "AccountingExport",
  },
  {
    id: "customer-success",
    label: "Customer Success",
    provides: "Customer health, renewal tracking (consumer of Sales summaries)",
    markerEntity: "CustomerSuccessProfile",
  },
  {
    id: "projects",
    label: "Projects",
    provides: "Delivery milestones linked to sales orders",
    markerEntity: "Project",
  },
];

export const SALES_FEATURES: readonly SalesFeatureDescriptor[] = [
  {
    key: "productPrices",
    label: "Product-level prices",
    settingsPath: "features.productPrices",
    requires: [],
  },
  {
    key: "taxInclusivePrices",
    label: "Tax-inclusive pricing by default",
    settingsPath: "features.taxInclusivePrices",
    requires: [],
  },
  {
    key: "priceBooks",
    label: "Price books and price rules",
    settingsPath: "features.priceBooks",
    requires: [],
  },
  {
    key: "productVariants",
    label: "Product variants",
    settingsPath: "features.productVariants",
    requires: [],
  },
  {
    key: "supplierPrices",
    label: "Supplier purchase prices",
    settingsPath: "features.supplierPrices",
    requires: [],
  },
  {
    key: "purchases",
    label: "Purchases",
    settingsPath: "features.purchases",
    requires: ["supplierPrices"],
  },
  {
    key: "inventory",
    label: "Inventory",
    settingsPath: "features.inventory",
    requires: [],
  },
  {
    key: "subscriptions",
    label: "Subscriptions",
    settingsPath: "features.subscriptions",
    requires: [],
  },
  {
    key: "paymentRequests",
    label: "Payment requests",
    settingsPath: "features.paymentRequests",
    requires: [],
  },
  {
    key: "multiCurrency",
    label: "Multi-currency documents",
    settingsPath: "features.multiCurrency",
    requires: [],
  },
  {
    key: "issuanceLocking",
    label: "Issuance locking",
    settingsPath: "features.issuanceLocking",
    requires: [],
  },
];

export const SALES_MODULE = {
  id: "sales",
  name: "Sales & Commercial Operations",
  version: "1.0.0",
  minPlatformVersion: "1.0.0",
  /** Kernel module directories load in this order; Sales runs after the kernel and Projects. */
  loadOrder: 320,
  /** API prefix owned by the module's domain commands; entity CRUD stays on `/api/v1/:entity`. */
  apiPrefix: "/api/v1/Sales",
  /**
   * Phases implemented so far (PLAN_Phase_19_Sales.md §14).
   *
   * `19-S.6` is the shared document infrastructure; `19-S.7` is quotes, including rendering a quote
   * through the kernel `document` module and emailing it through the mail module; `19-S.8`/`19-S.9` are
   * sales orders and invoices; `19-S.10` is payments and allocation; `19-S.11` is credit notes and
   * write-offs (allocation, soft reversal, request/approve/reject and the credit-note render path).
   * `19-S.12`/`19-S.13` are delivery/return orders and the purchasing half; `19-S.14` is the inventory
   * foundations — warehouses, the append-only stock ledger, reviewed adjustments, two-sided transfers
   * and concurrency-safe reservations, which is what now applies the movement plans those phases froze
   * into a document's snapshot. `19-S.15` adds stock identity and removal: configurable variant
   * attributes, lots and serialised units, expiry-validated dates, and the FIFO/FEFO/LIFO policy that
   * decides which units an outbound movement consumes. `19-S.16` adds recurring billing:
   * subscriptions, their computed periods, and an idempotent run that issues one invoice per due
   * period.
   *
   * A PDF *attachment* on a sent document is still not produced: the block model and the optional
   * `pdfkit` adapter exist (`@carocrm/document`), but wiring a rendered PDF into an outbound message
   * needs the attachment storage path, which is not built. See `docs/modules/sales/README.md` for the
   * per-phase detail.
   */
  implementedPhases: [
    "19-S.0",
    "19-S.1",
    "19-S.2",
    "19-S.3",
    "19-S.4",
    "19-S.5",
    "19-S.6",
    "19-S.7",
    "19-S.8",
    "19-S.9",
    "19-S.10",
    "19-S.11",
    "19-S.12",
    "19-S.13",
    "19-S.14",
    "19-S.15",
    "19-S.16",
  ],
} as const;

export type SalesModuleDescriptor = typeof SALES_MODULE;
