/**
 * Phase 25.3 — provider capability table.
 *
 * The table is derived from the adapter objects registered in `ai-provider.ts`. A preset is only
 * configuration, so it inherits the declared capabilities of its transport adapter; it never adds
 * a capability of its own. Presets with an adapter-contract test or a local-compatible seam test are
 * labelled accordingly, and everything else stays explicitly unverified.
 */

import type { AIProviderCapabilities, AIProviderRegistry } from './ai-provider.js';
import { type AIProviderPreset, providerPresets } from './ai-provider-presets.js';

export type AIProviderPresetVerification =
  | 'adapter-contract'
  | 'local-compatible-seam'
  | 'not-verified';

export interface AIProviderCapabilityRow {
  readonly key: string;
  readonly label: string;
  readonly capabilities: AIProviderCapabilities;
}

export interface AIProviderPresetCapabilityRow {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly verification: AIProviderPresetVerification;
  readonly capabilities: AIProviderCapabilities | null;
}

const ADAPTER_CONTRACT_PRESETS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'fake']);
const LOCAL_COMPATIBLE_PRESETS: ReadonlySet<string> = new Set(['gemini']);

function verificationFor(preset: AIProviderPreset): AIProviderPresetVerification {
  if (LOCAL_COMPATIBLE_PRESETS.has(preset.key)) return 'local-compatible-seam';
  if (ADAPTER_CONTRACT_PRESETS.has(preset.key)) return 'adapter-contract';
  return 'not-verified';
}

export function describeProviderCapabilities(
  registry: AIProviderRegistry,
): readonly AIProviderCapabilityRow[] {
  return registry.list().map((adapter) => ({
    key: adapter.key,
    label: adapter.label,
    capabilities: { ...adapter.capabilities },
  }));
}

export function describePresetCapabilities(
  registry: AIProviderRegistry,
  includeFake: boolean,
): readonly AIProviderPresetCapabilityRow[] {
  return providerPresets(includeFake).map((preset) => ({
    key: preset.key,
    label: preset.label,
    kind: preset.kind,
    verification: registry.has(preset.kind) ? verificationFor(preset) : 'not-verified',
    capabilities: registry.has(preset.kind) ? { ...registry.get(preset.kind).capabilities } : null,
  }));
}
