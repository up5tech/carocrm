import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { LEADSCORE_MODULE } from '../src/lead-score/lead-score-module.js';
import { SALES_MODULE } from '../src/sales/sales-module.js';
import { VOICE_COMMUNICATIONS_MODULE } from '../src/voice-communications/voice-communications-module.js';

/**
 * Phase 19 — the module descriptors' phase lists, pinned.
 *
 * `implementedPhases` is what `GET <module>/action/health` and the SPA's module card repeat, so it is a
 * claim about the product rather than a note about the code. Three of them had drifted, in both
 * directions: Sales declared S.0–S.16 + S.18 while S.17 and S.19 had shipped; LeadScore declared
 * LS.0–LS.13 + LS.16 + LS.17 while LS.14, LS.15 and LS.18 had shipped; Voice declared through VC.17 while
 * the VC.18 administration screen had shipped. Nothing pinned any of the three, which is how a list can
 * lag for weeks without a single test noticing.
 *
 * Runs with no database and no app boot — it reads the descriptors and the filesystem — so it belongs in
 * the scheduled CI gate (`vitest.ci.config.ts`).
 */

/** The phases each module declares, in full, in order. Adding one is a deliberate act. */
const DECLARED: Record<string, readonly string[]> = {
  Sales: [
    '19-S.0', '19-S.1', '19-S.2', '19-S.3', '19-S.4', '19-S.5', '19-S.6', '19-S.7', '19-S.8', '19-S.9',
    '19-S.10', '19-S.11', '19-S.12', '19-S.13', '19-S.14', '19-S.15', '19-S.16', '19-S.17', '19-S.18',
    '19-S.19',
  ],
  LeadScore: [
    '19-LS.0', '19-LS.1', '19-LS.2', '19-LS.3', '19-LS.4', '19-LS.5', '19-LS.6', '19-LS.7', '19-LS.8',
    '19-LS.9', '19-LS.10', '19-LS.11', '19-LS.12', '19-LS.13', '19-LS.14', '19-LS.15', '19-LS.16',
    '19-LS.17', '19-LS.18',
  ],
  VoiceCommunications: [
    '19-VC.0', '19-VC.1', '19-VC.2', '19-VC.3', '19-VC.4', '19-VC.5', '19-VC.6', '19-VC.7', '19-VC.8',
    '19-VC.9', '19-VC.10', '19-VC.11', '19-VC.12', '19-VC.13', '19-VC.14', '19-VC.15', '19-VC.16',
    '19-VC.17', '19-VC.18',
  ],
};

/**
 * The phases declared on 2026-11-03 that had shipped unclaimed, each with the artifact that proves it.
 * A declaration without a file behind it is exactly the failure mode this test exists to catch, so the
 * evidence is checked rather than asserted in a comment.
 */
const NEWLY_CLAIMED_EVIDENCE: Record<string, readonly string[]> = {
  '19-S.17': [
    'apps/api/src/sales/document/document-send.service.ts',
    'apps/web/src/components/DocumentSendModal.tsx',
    'apps/api/test/sales-document-send.test.ts',
    'apps/api/test/sales-entity-layouts.test.ts',
    'e2e/sales-documents.spec.ts',
  ],
  '19-S.19': [
    'apps/api/src/sales/sales.controller.ts',
    'apps/api/test/sales-integrations-api.test.ts',
  ],
  '19-LS.14': [
    'apps/web/src/components/LeadConversionWizard.tsx',
    'apps/api/test/lead-score-conversion.test.ts',
    'e2e/lead-conversion.spec.ts',
    'docs/implementation/lead-score-ls14-completion-report.md',
  ],
  '19-LS.15': [
    'apps/api/test/lead-score-conversion-history.test.ts',
    'docs/implementation/lead-score-ls15-completion-report.md',
  ],
  '19-LS.18': [
    'apps/api/test/lead-score-release.test.ts',
    'database/migrations/076_phase19_lead_score_dashlet.sql',
    'docs/runbooks/lead-score-operations.md',
    'docs/implementation/lead-score-ls18-completion-report.md',
  ],
  '19-VC.18': [
    'apps/web/src/admin/tabs/VoiceCommunicationsSettingsTab.tsx',
    'apps/api/src/admin-panel/admin-panel.service.ts',
  ],
};

const descriptors: readonly { readonly module: string; readonly phases: readonly string[] }[] = [
  { module: 'Sales', phases: SALES_MODULE.implementedPhases },
  { module: 'LeadScore', phases: LEADSCORE_MODULE.implementedPhases },
  { module: 'VoiceCommunications', phases: VOICE_COMMUNICATIONS_MODULE.implementedPhases },
];

describe('the Phase 19 module declarations (audited 2026-11-03)', () => {
  for (const entry of descriptors) {
    it(`${entry.module} declares exactly the phases it has delivered`, () => {
      expect(entry.phases).toEqual(DECLARED[entry.module] ?? []);
    });

    it(`${entry.module} declares each phase once, in order`, () => {
      expect(new Set(entry.phases).size).toBe(entry.phases.length);
      // Ordered by number, not by string: '19-S.19' sorts before '19-S.2' as text, and a list a human
      // reads should read as a timeline.
      const numbers = entry.phases.map((phase) => Number(phase.split('.')[1]));
      expect(numbers).toEqual([...numbers].sort((left, right) => left - right));
    });
  }

  it('has a real artifact behind every phase it claimed late', () => {
    for (const [phase, artifacts] of Object.entries(NEWLY_CLAIMED_EVIDENCE)) {
      for (const artifact of artifacts) {
        expect(existsSync(artifact), `${phase} is declared, but ${artifact} does not exist`).toBe(true);
      }
    }
  });

  it('does not claim the Voice phases that were never started', () => {
    // VC.19 reporting, VC.20 hardening and VC.21 QA/release have no code, tests or docs; declaring them
    // would be the same mistake in the other direction.
    for (const phase of ['19-VC.19', '19-VC.20', '19-VC.21']) {
      expect(VOICE_COMMUNICATIONS_MODULE.implementedPhases).not.toContain(phase);
    }
    // Sales' Tier 4 e-invoicing/export adapters and its §18 documents are likewise still open (§19-S.20
    // gap report), so S.20 — the gap-report phase — is declared nowhere either.
    expect(SALES_MODULE.implementedPhases).not.toContain('19-S.20');
  });
});
