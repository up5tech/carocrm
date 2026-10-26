import type { Provider, Type } from "@nestjs/common";

import { CaseAssignmentService } from "./case-assignment.service.js";
import { CaseConversationService } from "./case-conversation.service.js";
import { CaseHandoffService } from "./case-handoff.service.js";
import { CaseLifecycleService } from "./case-lifecycle.service.js";
import { CaseMergeService } from "./case-merge.service.js";
import { CaseNumberingService } from "./case-numbering.service.js";
import { CsatService } from "./csat.service.js";
import { EmailToCaseService } from "./email-to-case.service.js";
import { KnowledgeBaseService } from "./knowledge-base.service.js";
import { ServiceDeskController } from "./service-desk.controller.js";
import { ServiceDeskMetricsService } from "./service-desk-metrics.service.js";
import { ServiceDeskModuleHealthService } from "./service-desk-module-health.service.js";
import { ServiceDeskNotificationService } from "./service-desk-notification.service.js";
import { ServiceDeskRecords } from "./service-desk-records.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";
import { ServiceDeskWriteGuardService } from "./service-desk-write-guard.service.js";
import { SlaService } from "./sla.service.js";
import { WebToCaseService } from "./web-to-case.service.js";

export type { CaseContextView, CaseHandoffInput, CaseHandoffResult } from "./case-handoff.service.js";
export { CaseHandoffService } from "./case-handoff.service.js";
export { CaseMergeService } from "./case-merge.service.js";
export { CsatService } from "./csat.service.js";
export { KnowledgeBaseService } from "./knowledge-base.service.js";
export { ServiceDeskSettingsService } from "./service-desk-settings.service.js";
export { SlaService } from "./sla.service.js";
export { WebToCaseService } from "./web-to-case.service.js";

/**
 * Phase 19-SD.1 – 19-SD.7 — Service Desk module barrel (PLAN_Phase_19_ServiceDesk.md §7.1).
 */
export const SERVICE_DESK_CONTROLLERS: Type<unknown>[] = [ServiceDeskController];

export const SERVICE_DESK_PROVIDERS: Provider[] = [
  ServiceDeskSettingsService,
  ServiceDeskRecords,
  CaseNumberingService,
  ServiceDeskNotificationService,
  ServiceDeskWriteGuardService,
  CaseLifecycleService,
  CaseAssignmentService,
  CaseHandoffService,
  CaseConversationService,
  EmailToCaseService,
  ServiceDeskModuleHealthService,
  ServiceDeskMetricsService,
  SlaService,
  KnowledgeBaseService,
  WebToCaseService,
  CaseMergeService,
  CsatService,
];

export { type CaseAssignInput, type CaseAssignmentDecision, type CaseAssignmentResult, CaseAssignmentService, type CaseRouteResult, type QueueWorkload } from "./case-assignment.service.js";
export {
  type CaseConversationCapabilities,
  CaseConversationService,
  type CaseConversationTimeline,
  type CaseMessageInput,
  type CaseMessageResult,
} from "./case-conversation.service.js";
export { type CaseCapabilities, CaseLifecycleService, type CaseTransitionRequest, type CaseTransitionResult } from "./case-lifecycle.service.js";
export {
  type CaseEmailReplyResult,
  EmailToCaseService,
  type ProcessEmailResult,
} from "./email-to-case.service.js";
