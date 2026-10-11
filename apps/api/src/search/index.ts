import type { Provider, Type } from '@nestjs/common';

import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { ImportExportController } from './import-export.controller.js';
import { ImportExportService } from './import-export.service.js';
import { PortalSearchService } from './portal-search.service.js';
import { SavedFilterController } from './saved-filter.controller.js';
import { SavedFilterService } from './saved-filter.service.js';
import { SearchController } from './search.controller.js';

export { csvCell, parseCsv, safeJson, toCsvText } from './csv.js';
export { DashboardService } from './dashboard.service.js';
export { ImportExportService } from './import-export.service.js';
export { PortalSearchService } from './portal-search.service.js';
export { SavedFilterService } from './saved-filter.service.js';
export const SEARCH_PROVIDERS: Provider[] = [PortalSearchService, SavedFilterService, ImportExportService, DashboardService];
export const SEARCH_CONTROLLERS: Type<unknown>[] = [SearchController, SavedFilterController, DashboardController, ImportExportController];
