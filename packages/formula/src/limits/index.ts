/** Execution budgets (PLAN §22: limit execution time and expression complexity). */
export interface FormulaLimits {
  maxSourceLength: number;
  maxNodes: number;
  maxDepth: number;
  maxSteps: number;
  maxCallArgs: number;
  maxStringLength: number;
  maxArrayLength: number;
}

export const DEFAULT_LIMITS: FormulaLimits = {
  maxSourceLength: 2000,
  maxNodes: 500,
  maxDepth: 48,
  maxSteps: 100_000,
  maxCallArgs: 32,
  maxStringLength: 50_000,
  maxArrayLength: 2_000,
};

export function resolveLimits(overrides?: Partial<FormulaLimits> | undefined): FormulaLimits {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {}) as [keyof FormulaLimits, number | undefined][]) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) limits[key] = value;
  }
  return limits;
}
