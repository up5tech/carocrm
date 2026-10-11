import type { Provider, Type } from '@nestjs/common';

import { FormulaController } from './formula.controller.js';
import { FormulaService } from './formula.service.js';
import { RecordLogicService } from './record-logic.service.js';

export { FormulaService } from './formula.service.js';
export { RecordLogicService } from './record-logic.service.js';

/**
 * Formula + dynamic logic module barrel (PLAN §21, §22).
 *
 * `LOGIC_CONTROLLERS` owns the static `/api/v1/Formula` prefix and must be spread BEFORE
 * `ENTITY_CONTROLLERS`, whose `:entity` wildcard would otherwise swallow it (same rule as the
 * stream/calendar controllers in docs/module-guide.md).
 */
export const LOGIC_CONTROLLERS: Type<unknown>[] = [FormulaController];

export const LOGIC_PROVIDERS: Provider[] = [FormulaService, RecordLogicService];
