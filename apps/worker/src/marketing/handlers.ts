import type { Logger } from '@carocrm/core/logger/index.js';

import { pauseSendJob , recoverClaimsJob,resumeSendJob  } from './mail-handlers.js';

export const MARKETING_JOB_NAMES = {
  pauseSend: 'marketing.pauseSend',
  resumeSend: 'marketing.resumeSend',
  recoverClaims: 'marketing.recoverClaims',
};

export function registerMarketingJobs(jobRegistry: any, deps: {
  readonly db: any;
  readonly log: Logger;
}): void {
  jobRegistry.register(MARKETING_JOB_NAMES.pauseSend, pauseSendJob(deps));
  jobRegistry.register(MARKETING_JOB_NAMES.resumeSend, resumeSendJob(deps));
  jobRegistry.register(MARKETING_JOB_NAMES.recoverClaims, recoverClaimsJob(deps));
}