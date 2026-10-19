import type { Provider, Type } from '@nestjs/common';

import { SetupChecklistController } from './setup-checklist.controller.js';
import { SetupChecklistService } from './setup-checklist.service.js';

export { SetupChecklistController } from './setup-checklist.controller.js';
export { SetupChecklistService } from './setup-checklist.service.js';
export type { SetupChecklistItem } from './setup-checklist.service.js';

export const SETUP_CHECKLIST_PROVIDERS: Provider[] = [SetupChecklistService];

export const SETUP_CHECKLIST_CONTROLLERS: Type<unknown>[] = [SetupChecklistController];
