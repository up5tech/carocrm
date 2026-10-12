import type { Provider, Type } from '@nestjs/common';

import { ReportController } from './report.controller.js';
import { ReportService } from './report.service.js';

export { ReportService } from './report.service.js';
export const REPORT_PROVIDERS: Provider[] = [ReportService];
export const REPORT_CONTROLLERS: Type<unknown>[] = [ReportController];
