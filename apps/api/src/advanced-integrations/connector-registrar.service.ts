import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import { assertConnectorContract } from './connector-contract.js';
import { FakeProviderAdapter } from './connectors/fake/fake-provider.adapter.js';
import { GenericRestAdapter } from './connectors/generic-rest/generic-rest.adapter.js';
import { GoogleWorkspaceAdapter } from './connectors/google-workspace/google-workspace.adapter.js';
import { parseOauthClientIds } from './connectors/kit/oauth2-base.js';
import { MailchimpAdapter } from './connectors/mailchimp/mailchimp.adapter.js';
import { MetaLeadAdsAdapter } from './connectors/meta-lead-ads/meta-lead-ads.adapter.js';
import { Microsoft365Adapter } from './connectors/microsoft-365/microsoft-365.adapter.js';
import { QuickbooksOnlineAdapter } from './connectors/quickbooks-online/quickbooks-online.adapter.js';
import { ShopifyAdapter } from './connectors/shopify/shopify.adapter.js';
import { StripeAdapter } from './connectors/stripe/stripe.adapter.js';
import { ZoomAdapter } from './connectors/zoom/zoom.adapter.js';
import {
  type IntegrationProviderDefinition,
  IntegrationRegistry,
  type ProviderStatus,
} from './integration-registry.service.js';

/**
 * Phase 19-INT.16–19-INT.24 — the connector catalog registration
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.2, §12; `19-INT.16`–`19-INT.24`).
 *
 * The registry is **code-registered** (ADR 0002, decision 5), so a connector's capability
 * declaration cannot drift from the adapter that implements it. This service is where the nine
 * connectors of phases 19-INT.16–19-INT.24 enter that registry.
 *
 * Two rules govern the registration:
 *
 *  1. **A connector that breaks the contract is not registered.** Every adapter is checked against
 *     the conformance suite first, so a malformed declaration stops the module from loading rather
 *     than reaching the admin UI.
 *  2. **Nothing is enabled by default.** A registered connector is *available*; it is not
 *     connected, and a connection still has to be created, authorized and mapped. The fake
 *     provider is the exception: it is registered outside production so a development
 *     installation has something to exercise, and it is never registered in production — a live
 *     deployment must not be able to select a provider that fabricates answers.
 *
 * The OAuth client ids are deployment configuration, not secrets, so they live in the
 * configuration. The matching **client secret** is per connection and lives in the credential
 * vault.
 */
@Injectable()
export class ConnectorRegistrar implements OnModuleInit {
  constructor(
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.registerAll();
  }

  /** Register every connector this installation offers. */
  registerAll(): void {
    for (const definition of this.definitions()) {
      assertConnectorContract(definition.adapter as NonNullable<typeof definition.adapter>);
      this.registry.register(definition);
    }
    this.registry.validateAll();
  }

  /** The provider definitions of the delivered connectors. */
  private definitions(): readonly IntegrationProviderDefinition[] {
    const clientIds = parseOauthClientIds(this.config.integrationOauthClientIds);
    const identity = (providerKey: string): { clientId: string; clientSecret: string | null } | null => {
      const clientId = clientIds[providerKey];
      return clientId === undefined ? null : { clientId, clientSecret: null };
    };

    // One adapter per provider: the declaration and the adapter must never be two different
    // objects, or the catalog could describe a connector that is not the one that runs.
    const google = new GoogleWorkspaceAdapter({ identity });
    const microsoft = new Microsoft365Adapter({ identity });
    const zoom = new ZoomAdapter({ identity });
    const stripe = new StripeAdapter();
    const mailchimp = new MailchimpAdapter({ identity });
    const meta = new MetaLeadAdsAdapter({ identity });
    const shopify = new ShopifyAdapter();
    const quickbooks = new QuickbooksOnlineAdapter({ identity });
    const genericRest = new GenericRestAdapter();
    const fake = new FakeProviderAdapter();

    const definitions: IntegrationProviderDefinition[] = [
      {
        providerKey: 'google-workspace',
        displayName: 'Google Workspace',
        description: 'Calendar events and contacts, with incremental sync through Google sync tokens.',
        category: 'productivity',
        adapterVersion: '1.0.0',
        providerApiVersion: 'v3+v1',
        status: 'available',
        capabilities: google.getCapabilities(),
        requiredScopes: [
          'https://www.googleapis.com/auth/calendar.readonly',
          'https://www.googleapis.com/auth/contacts.readonly',
        ],
        optionalScopes: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/contacts',
        ],
        docsUrl: 'https://developers.google.com/workspace/calendar/api/guides/sync',
        setupInstructionsKey: 'advancedintegrations.providers.setupGoogleWorkspace',
        iconKey: 'google-workspace',
        adapter: google,
      },
      {
        providerKey: 'microsoft-365',
        displayName: 'Microsoft 365',
        description: 'Outlook calendar and contacts, with Microsoft Graph delta queries.',
        category: 'productivity',
        adapterVersion: '1.0.0',
        providerApiVersion: 'v1.0',
        status: 'available',
        capabilities: microsoft.getCapabilities(),
        requiredScopes: ['Calendars.Read', 'Contacts.Read'],
        optionalScopes: ['Calendars.ReadWrite', 'Contacts.ReadWrite'],
        docsUrl: 'https://learn.microsoft.com/graph/delta-query-overview',
        setupInstructionsKey: 'advancedintegrations.providers.setupMicrosoft365',
        iconKey: 'microsoft-365',
        adapter: microsoft,
      },
      {
        providerKey: 'zoom',
        displayName: 'Zoom',
        description: 'Meetings created from CRM records, with signed webhook notifications.',
        category: 'productivity',
        adapterVersion: '1.0.0',
        providerApiVersion: 'v2',
        status: 'available',
        capabilities: zoom.getCapabilities(),
        requiredScopes: ['meeting:read'],
        optionalScopes: ['meeting:write'],
        docsUrl: 'https://developers.zoom.us/docs/api/webhooks/',
        setupInstructionsKey: 'advancedintegrations.providers.setupZoom',
        iconKey: 'zoom',
        adapter: zoom,
      },
      {
        providerKey: 'stripe',
        displayName: 'Stripe',
        description:
          'Payment intents, customers and checkout sessions, read-only. Payment transitions run through the Sales domain service.',
        category: 'payments',
        adapterVersion: '1.0.0',
        providerApiVersion: 'v1',
        status: 'available',
        capabilities: stripe.getCapabilities(),
        requiredScopes: [],
        optionalScopes: [],
        docsUrl: 'https://docs.stripe.com/webhooks',
        setupInstructionsKey: 'advancedintegrations.providers.setupStripe',
        iconKey: 'stripe',
        adapter: stripe,
      },
      {
        providerKey: 'mailchimp',
        displayName: 'Mailchimp',
        description:
          'Audience members and campaign activity. Consent and suppression stay with Marketing Automation.',
        category: 'marketing',
        adapterVersion: '1.0.0',
        providerApiVersion: '3.0',
        status: 'available',
        capabilities: mailchimp.getCapabilities(),
        requiredScopes: [],
        optionalScopes: [],
        docsUrl: 'https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/',
        setupInstructionsKey: 'advancedintegrations.providers.setupMailchimp',
        iconKey: 'mailchimp',
        adapter: mailchimp,
      },
      {
        providerKey: 'meta-lead-ads',
        displayName: 'Meta Lead Ads',
        description: 'Lead form submissions, deduplicated by the provider submission id.',
        category: 'marketing',
        adapterVersion: '1.0.0',
        providerApiVersion: 'v21.0',
        status: 'available',
        capabilities: meta.getCapabilities(),
        requiredScopes: ['ads_read'],
        optionalScopes: [],
        docsUrl: 'https://developers.facebook.com/docs/marketing-api/guides/lead-ads/',
        setupInstructionsKey: 'advancedintegrations.providers.setupMetaLeadAds',
        iconKey: 'meta-lead-ads',
        adapter: meta,
      },
      {
        providerKey: 'shopify',
        displayName: 'Shopify',
        description: 'Orders, customers and products of a store, inbound only.',
        category: 'commerce',
        adapterVersion: '1.0.0',
        providerApiVersion: '2024-10',
        status: 'available',
        capabilities: shopify.getCapabilities(),
        requiredScopes: [],
        optionalScopes: [],
        docsUrl: 'https://shopify.dev/docs/apps/build/webhooks/verify-deliveries',
        setupInstructionsKey: 'advancedintegrations.providers.setupShopify',
        iconKey: 'shopify',
        adapter: shopify,
      },
      {
        providerKey: 'quickbooks-online',
        displayName: 'QuickBooks Online',
        description: 'Customers, invoices and payments of a company, read-only.',
        category: 'accounting',
        adapterVersion: '1.0.0',
        providerApiVersion: 'minorversion=75',
        status: 'available',
        capabilities: quickbooks.getCapabilities(),
        requiredScopes: [],
        optionalScopes: [],
        docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/get-started',
        setupInstructionsKey: 'advancedintegrations.providers.setupQuickbooksOnline',
        iconKey: 'quickbooks-online',
        adapter: quickbooks,
      },
      {
        providerKey: 'generic-rest',
        displayName: 'Generic REST API',
        description: 'A vetted external REST API, read through an allowlisted endpoint.',
        category: 'platform',
        adapterVersion: '1.0.0',
        providerApiVersion: '1',
        status: 'available',
        capabilities: genericRest.getCapabilities(),
        requiredScopes: [],
        optionalScopes: [],
        docsUrl: null,
        setupInstructionsKey: 'advancedintegrations.providers.setupGenericRest',
        iconKey: 'generic-rest',
        adapter: genericRest,
      },
    ];

    // The fake provider is a development aid. A live deployment must not be able to select a
    // provider that fabricates answers, so it is never registered there.
    if (process.env.NODE_ENV !== 'production') {
      definitions.push({
        providerKey: 'fake-provider',
        displayName: 'Fake provider',
        description: 'A deterministic in-process provider used by the tests and by local development.',
        category: 'platform',
        adapterVersion: '1.0.0',
        providerApiVersion: '2026-01-01',
        status: 'deprecated' satisfies ProviderStatus,
        capabilities: fake.getCapabilities(),
        requiredScopes: ['fake.read'],
        optionalScopes: ['fake.write'],
        docsUrl: null,
        setupInstructionsKey: 'advancedintegrations.providers.setupFakeProvider',
        iconKey: 'generic-rest',
        adapter: fake,
      });
    }

    return definitions;
  }
}
