import type { Provider, Type } from '@nestjs/common';

import { DocsController } from './docs.controller.js';
import { DocsService } from './docs.service.js';
import { DocsSettingsService } from './docs-settings.service.js';

export { DocsController } from './docs.controller.js';
export { type DocsPageResult, type DocsSearchResult, DocsService, type DocsTree } from './docs.service.js';
export { DocsSettingsService } from './docs-settings.service.js';

export const DOCS_PROVIDERS: Provider[] = [DocsSettingsService, DocsService];

export const DOCS_CONTROLLERS: Type<unknown>[] = [DocsController];
