import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";

/**
 * Phase 19-VC.9 — incoming-call notifications
 * (`PLAN_Phase_19_Voice_Communications.md` §7.2, §15 `19-VC.9`).
 *
 * The platform has no realtime gateway (audit §1), so the popup's delivery mechanism is the existing
 * `notifications` table — the same store Service Desk and Customer Success write — and the SPA polls
 * it. This service only decides **who** may be told and **what** they are told:
 *
 *  - Recipients are the call's assigned user, or the members of the endpoint's team. Never every
 *    signed-in user (§7.2 "do not broadcast caller names or CRM details to every logged-in user").
 *  - The payload carries the number only. A caller's name is resolved later, through the
 *    authorization-aware context endpoint, so a notification cannot leak a restricted record.
 *  - One row per `(call, recipient)`: a replayed ringing callback cannot produce a second popup.
 *
 * The setting that gates it is the same `features.voice` flag the policy service reads, so an
 * installation that disabled voice produces no rows at all.
 */

export interface IncomingCallNotification {
  readonly sessionId: string;
  readonly accountKey: string;
  readonly endpointId: string | null;
  readonly assignedUserId: string | null;
  readonly fromDisplay: string | null;
  readonly fromNumber: string | null;
}

export interface NotificationWriteResult {
  readonly recipients: number;
  readonly created: number;
}

interface NotificationRow {
  user_id: string;
}

@Injectable()
export class VoiceCallNotificationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
  ) {}

  async incomingCall(input: IncomingCallNotification): Promise<NotificationWriteResult> {
    const settings = await this.settings.settings();
    if (!settings.features.voice) return { recipients: 0, created: 0 };

    const recipients = await this.recipientsFor(input);
    if (recipients.length === 0) return { recipients: 0, created: 0 };

    const dedupKey = `voiceCall:${input.sessionId}:ringing`;
    const number = input.fromDisplay ?? input.fromNumber ?? "";
    let created = 0;
    for (const userId of recipients) {
      if (await this.alreadyNotified(userId, dedupKey)) continue;
      const data = {
        title: number === "" ? "Incoming call" : `Incoming call from ${number}`,
        body: "",
        link: "/voice-communications",
        dedupKey,
        module: "VoiceCommunications",
        callSessionId: input.sessionId,
        accountKey: input.accountKey,
      };
      await this.database.db
        .insertInto("notifications")
        .values({
          id: randomUUID(),
          type: "VoiceCommunicationsIncomingCall",
          user_id: userId,
          data: JSON.stringify(data),
          is_read: false,
          created_at: new Date(),
        })
        .execute();
      created += 1;
    }
    return { recipients: recipients.length, created };
  }

  /**
   * The assigned user wins. Otherwise the endpoint's team members are told; an endpoint with no
   * team and no assignee notifies nobody, which is the safe default — a call with no owner is
   * visible in the call list, not pushed to whoever happens to be online.
   */
  private async recipientsFor(input: IncomingCallNotification): Promise<string[]> {
    if (input.assignedUserId !== null) return [input.assignedUserId];
    if (input.endpointId === null) return [];
    const rows = await sql<NotificationRow>`
      select ut.user_id
      from users_teams ut
      join voice_endpoints e on e.team_id = ut.team_id
      where e.id = ${input.endpointId} and e.team_id is not null
    `.execute(this.database.db);
    return [...new Set(rows.rows.map((row) => row.user_id))];
  }

  private async alreadyNotified(userId: string, dedupKey: string): Promise<boolean> {
    const rows = await sql<{ id: string }>`
      select id from notifications
      where user_id = ${userId} and (data ->> 'dedupKey') = ${dedupKey}
      limit 1
    `.execute(this.database.db);
    return rows.rows.length > 0;
  }
}
