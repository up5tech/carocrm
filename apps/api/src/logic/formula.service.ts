import { ValidationError } from '@carocrm/core/errors/index.js';
import type { DynamicLogicRule } from '@carocrm/formula/dynamic-logic/index.js';
import { readFieldsOf } from '@carocrm/formula/dynamic-logic/index.js';
import { FormulaEngine, parseDynamicLogic, validateDynamicLogic } from '@carocrm/formula/index.js';
import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { Injectable } from '@nestjs/common';

/** Columns every generic record carries, whether or not metadata lists them as fields. */
const PHYSICAL_FIELDS: readonly string[] = [
  'id',
  'name',
  'createdAt',
  'modifiedAt',
  'assignedUserId',
  'createdById',
  'modifiedById',
  'teams',
  'deletedAt',
  'version',
];

/**
 * Owns the formula sandbox (PLAN §22) and the rule set that describes it (PLAN §21). Metadata is
 * checked here before it can ever reach the registry, so a typo in an admin's rule is a 422 on the
 * metadata call rather than a broken record write later.
 */
@Injectable()
export class FormulaService {
  readonly engine = new FormulaEngine();

  /** Field names a rule may read or target: metadata fields plus the physical columns. */
  knownFields(definition: EntityDefinition): Set<string> {
    return new Set([...Object.keys(definition.fields), ...PHYSICAL_FIELDS]);
  }

  parseRules(definition: EntityDefinition): DynamicLogicRule[] {
    const section = definition.dynamicLogic;
    if (section === undefined) return [];
    const parsed = parseDynamicLogic(section);
    if (parsed.problems.length > 0) {
      throw new ValidationError(`Invalid dynamic logic for "${definition.name}".`, { issues: parsed.problems });
    }
    return parsed.rules;
  }

  /** Throws when any field formula or dynamic logic rule is unusable. */
  validateDefinition(definition: EntityDefinition): void {
    const known = this.knownFields(definition);
    const issues: string[] = [];

    for (const [name, field] of Object.entries(definition.fields)) {
      const formula = field.formula;
      if (typeof formula !== 'string' || formula.trim() === '') continue;
      const result = this.engine.validate(formula);
      if (!result.valid) issues.push(`Field "${name}": formula — ${result.error ?? 'invalid expression'}`);
      if (field.type !== 'formula' && field.type !== 'generated') {
        issues.push(`Field "${name}": a formula is only allowed on a "formula" or "generated" field.`);
      }
      for (const read of readFieldsOf(formula)) {
        if (!known.has(read)) issues.push(`Field "${name}": formula reads unknown field "${read}".`);
      }
    }

    const parsed = parseDynamicLogic(definition.dynamicLogic);
    issues.push(...parsed.problems);
    issues.push(...validateDynamicLogic(parsed.rules, this.engine, known));

    if (issues.length > 0) {
      throw new ValidationError(`Invalid formula metadata for "${definition.name}".`, { issues: [...new Set(issues)] });
    }
  }
}
