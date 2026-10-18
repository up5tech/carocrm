import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import { CAMPAIGN_PURPOSES } from "./marketing-automation-domain.js";

export type JourneyNodeType = "start" | "end" | "action" | "condition" | "wait" | "split" | "join";

export const ALLOWED_NODE_TYPES: readonly JourneyNodeType[] = [
  "start", "end", "action", "condition", "wait", "split", "join",
];

export interface JourneyNode {
  readonly id: string;
  readonly type: JourneyNodeType;
  readonly name?: string;
  readonly next?: string;
  readonly then?: string;
  readonly otherwise?: string;
  readonly action?: string;
  readonly params?: Record<string, unknown>;
  readonly seconds?: number;
  readonly formula?: string;
}

export interface JourneyGraph {
  readonly start: string;
  readonly nodes: readonly JourneyNode[];
}

export interface JourneyValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

@Injectable()
export class MarketingJourneyDefinitionService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  validate(graph: unknown): JourneyValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (typeof graph !== "object" || graph === null) {
      return { valid: false, errors: ["Graph must be an object."], warnings };
    }
    const g = graph as Record<string, unknown>;
    if (typeof g.start !== "string" || g.start.trim() === "") {
      errors.push("Graph must declare a non-empty `start` node id.");
    }
    if (!Array.isArray(g.nodes) || g.nodes.length === 0) {
      errors.push("Graph must contain at least one node.");
      return { valid: false, errors, warnings };
    }
    const nodes = g.nodes as unknown[];
    const byId = new Map<string, JourneyNode>();
    const ids = new Set<string>();
    for (const raw of nodes) {
      if (typeof raw !== "object" || raw === null) {
        errors.push("Every node must be an object.");
        continue;
      }
      const n = raw as Record<string, unknown>;
      if (typeof n.id !== "string" || n.id.trim() === "") {
        errors.push("Every node must have a non-empty string `id`.");
        continue;
      }
      if (ids.has(n.id)) {
        errors.push(`Duplicate node id "${n.id}".`);
        continue;
      }
      ids.add(n.id);
      if (typeof n.type !== "string" || !ALLOWED_NODE_TYPES.includes(n.type as JourneyNodeType)) {
        errors.push(`Node "${n.id}" has an unsupported type "${String(n.type)}".`);
        continue;
      }
      const node: JourneyNode = {
        id: n.id,
        type: n.type as JourneyNodeType,
        ...(typeof n.name === "string" ? { name: n.name } : {}),
        ...(typeof n.next === "string" ? { next: n.next } : {}),
        ...(typeof n.then === "string" ? { then: n.then } : {}),
        ...(typeof n.otherwise === "string" ? { otherwise: n.otherwise } : {}),
        ...(typeof n.action === "string" ? { action: n.action } : {}),
        ...(n.params && typeof n.params === "object" ? { params: n.params as Record<string, unknown> } : {}),
        ...(typeof n.seconds === "number" ? { seconds: n.seconds } : {}),
        ...(typeof n.formula === "string" ? { formula: n.formula } : {}),
      };
      byId.set(n.id, node);
    }
    if (typeof g.start === "string" && !byId.has(g.start)) {
      errors.push(`Start node "${g.start}" does not exist.`);
    }
    for (const node of byId.values()) {
      if (node.type === "condition") {
        if (typeof node.then !== "string" || !byId.has(node.then)) {
          errors.push(`Condition node "${node.id}" must have a valid "then" port.`);
        }
        if (node.otherwise !== undefined && !byId.has(node.otherwise)) {
          errors.push(`Condition node "${node.id}" has an invalid "otherwise" port.`);
        }
      } else if (node.type !== "end") {
        if (node.next !== undefined && !byId.has(node.next)) {
          errors.push(`Node "${node.id}" references unknown next node "${node.next}".`);
        }
        if (node.type === "action" && (typeof node.action !== "string" || node.action.trim() === "")) {
          errors.push(`Action node "${node.id}" must declare an action.`);
        }
        if (node.type === "wait" && (typeof node.seconds !== "number" || node.seconds < 0)) {
          errors.push(`Wait node "${node.id}" must declare non-negative seconds.`);
        }
      }
      if (node.type === "split" && node.next === undefined && node.then === undefined) {
        errors.push(`Split node "${node.id}" is missing an outgoing port: declare \`next\` or \`then\`.`);
      }
      if (node.type === "action" && node.action === "sendEmail") {
        // MA.14 task 1: a journey send is delivered by MA.9's pipeline, so its three configuration
        // failures are publish-time errors, never runtime surprises — the delivery worker refuses a
        // sendEmail node without a named template, a named recipient type it can resolve, or a valid
        // purpose (and a template cannot invent a purpose: it must come from the allowlist).
        const templateId = (node.params as Record<string, unknown> | undefined)?.["templateId"];
        if (typeof templateId !== "string" || templateId.trim() === "") {
          errors.push(`Send-email node "${node.id}" must name a templateId; the delivery pipeline renders only named templates.`);
        }
        const recipientType = (node.params as Record<string, unknown> | undefined)?.["recipientType"];
        if (recipientType !== undefined && recipientType !== "Contact" && recipientType !== "Lead") {
          errors.push(`Send-email node "${node.id}" names an unsupported recipientType; use Contact or Lead, or omit it to use the enrollment's person.`);
        }
        const nodePurpose = (node.params as Record<string, unknown> | undefined)?.["purpose"];
        if (nodePurpose !== undefined && (typeof nodePurpose !== "string" || !(CAMPAIGN_PURPOSES as readonly string[]).includes(nodePurpose))) {
          errors.push(`Send-email node "${node.id}" names an unknown purpose; use one of ${CAMPAIGN_PURPOSES.join(", ")}.`);
        }
      }
    }
    if (errors.length === 0 && typeof g.start === "string" && byId.has(g.start)) {
      const visited = new Set<string>();
      const onStack = new Set<string>();
      let hasCycle = false;
      const dfs = (id: string) => {
        if (onStack.has(id)) { hasCycle = true; return; }
        if (visited.has(id)) return;
        visited.add(id);
        onStack.add(id);
        const node = byId.get(id);
        if (node) {
          const outs: string[] = [];
          if (node.next) outs.push(node.next);
          if (node.then) outs.push(node.then);
          if (node.otherwise) outs.push(node.otherwise);
          for (const o of outs) {
            if (byId.has(o)) dfs(o);
          }
        }
        onStack.delete(id);
      };
      dfs(g.start);
      if (hasCycle) errors.push("Graph contains a cycle.");
      for (const id of byId.keys()) {
        if (!visited.has(id)) warnings.push(`Node "${id}" is not reachable from start.`);
      }
      const reachableEnd = [...visited].some((id) => byId.get(id)?.type === "end");
      if (!reachableEnd) errors.push("Graph has no reachable terminal (end) node.");
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  hash(graph: unknown): string {
    return createHash("sha256").update(JSON.stringify(graph)).digest("hex");
  }

  async publish(journeyId: string, graph: unknown, releaseNotes?: string, actorUserId?: string): Promise<Record<string, unknown>> {
    const validation = this.validate(graph);
    if (!validation.valid) {
      throw new Error(`Cannot publish invalid graph: ${validation.errors.join("; ")}`);
    }
    const journey = await this.entities.get("MarketingJourney", journeyId, "*");
    const data = ((journey as { data?: Record<string, unknown> })?.data ?? (journey as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const currentVersion = Number(data.currentVersion ?? 0) + 1;
    const versionRecord = await runAsMarketingSystem(this.scope, "journeyPublishVersion", async () =>
      this.entities.create("MarketingJourneyVersion", {
        name: `v${currentVersion}`,
        journeyId,
        version: currentVersion,
        graph: JSON.stringify(graph),
        graphHash: this.hash(graph),
        schemaVersion: 1,
        publishedById: actorUserId ?? null,
        publishedAt: new Date(),
        releaseNotes: releaseNotes ?? null,
        status: "Published",
      }),
    );
    const versionId = (versionRecord as { id?: string; data?: { id?: string } })?.id ?? (versionRecord as { data?: { id?: string } })?.data?.id;
    await runAsMarketingSystem(this.scope, "journeyPublishUpdate", async () =>
      this.entities.update("MarketingJourney", journeyId, {
        status: "Published",
        publishedVersionId: versionId,
        currentVersion,
      }),
    );
    return { journeyId, versionId, version: currentVersion, graphHash: this.hash(graph) };
  }
}
