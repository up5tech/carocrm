/**
 * Phase 19-MA.12 — the journey graph, as the editor holds it.
 *
 * The shape is the server's, not the screen's: `MarketingJourneyDefinitionService` validates exactly this
 * `{ start, nodes[] }` document, where a node carries its outgoing edges as *ports* (`next`, `then`,
 * `otherwise`) rather than a separate edge list. Nothing here decides what is legal — `validate` is a
 * server call, and the editor renders the sentences it gets back.
 */

export const JOURNEY_NODE_TYPES = ['start', 'end', 'action', 'condition', 'wait', 'split', 'join'] as const;
export type JourneyNodeType = (typeof JOURNEY_NODE_TYPES)[number];

/** The allowlist the action node may choose from (`ALLOWED_JOURNEY_ACTIONS` on the server). */
export const JOURNEY_ACTIONS = ['sendEmail', 'createTask', 'notify', 'updateField'] as const;
export type JourneyAction = (typeof JOURNEY_ACTIONS)[number];

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

export type PortName = 'next' | 'then' | 'otherwise';

/** Which ports a node type can have; the editor only offers these, the server decides what is required. */
export function portsFor(type: JourneyNodeType): readonly PortName[] {
  if (type === 'condition' || type === 'split') return ['then', 'otherwise'];
  if (type === 'end') return [];
  return ['next'];
}

export function findNode(graph: JourneyGraph, id: string | undefined): JourneyNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

/** Every node id a picker may point at, including "no target" for a port that is being cleared. */
export function portOptions(graph: JourneyGraph): { value: string; label: string }[] {
  return graph.nodes.map((node) => ({ value: node.id, label: node.name === undefined || node.name === '' ? node.id : `${node.name} (${node.id})` }));
}

function newId(graph: JourneyGraph, base: string): string {
  const taken = new Set(graph.nodes.map((node) => node.id));
  let candidate = base;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${String(index)}`;
    index += 1;
  }
  return candidate;
}

export function emptyGraph(): JourneyGraph {
  return { start: 'start', nodes: [{ id: 'start', type: 'start' }] };
}

/** Insert `type` after `afterId`, threading the chain: the new node inherits the old target. */
export function insertAfter(graph: JourneyGraph, afterId: string, type: JourneyNodeType): JourneyGraph {
  const anchor = findNode(graph, afterId);
  if (anchor === undefined) return graph;
  const id = newId(graph, type === 'start' ? 'start' : type);
  const node: JourneyNode = {
    id,
    type,
    name: defaultName(type),
    ...(portsFor(type).includes('next') && anchor.next !== undefined ? { next: anchor.next } : {}),
    ...(type === 'action' ? { action: 'createTask', params: {} } : {}),
    ...(type === 'wait' ? { seconds: 3600 } : {}),
  };
  const nodes = graph.nodes.map((entry) => (entry.id === afterId ? { ...entry, next: id } : entry));
  return { start: graph.start, nodes: [...nodes, node] };
}

function defaultName(type: JourneyNodeType): string {
  return { start: 'Start', end: 'End', action: 'Action', condition: 'Condition', wait: 'Wait', split: 'Split', join: 'Join' }[type];
}

/**
 * Remove a node and re-point whatever flowed into it at where the removed node flowed on to, so deleting a
 * step does not strand the branch it sat on. A port that pointed at a node with no continuation is cleared.
 */
export function removeNode(graph: JourneyGraph, id: string): JourneyGraph {
  const target = findNode(graph, id);
  if (target === undefined) return graph;
  const continuation = target.next ?? target.then;
  const nodes = graph.nodes
    .filter((node) => node.id !== id)
    .map((node) => {
      let next = node;
      for (const port of portsFor(node.type)) {
        if (node[port] === id) {
          next = { ...next, [port]: continuation };
        }
      }
      return clearEmptyPorts(next);
    });
  const start = graph.start === id ? (nodes[0]?.id ?? '') : graph.start;
  return { start, nodes };
}

export function patchNode(graph: JourneyGraph, id: string, patch: Partial<JourneyNode>): JourneyGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === id ? clearEmptyPorts({ ...node, ...patch }) : node)),
  };
}

export function setPort(graph: JourneyGraph, id: string, port: PortName, target: string | undefined): JourneyGraph {
  return patchNode(graph, id, { [port]: target === '' ? undefined : target } as Partial<JourneyNode>);
}

/** Reorder the list. Order is presentation only — the graph is walked by ports, never by array position. */
export function moveNode(graph: JourneyGraph, id: string, direction: -1 | 1): JourneyGraph {
  const index = graph.nodes.findIndex((node) => node.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= graph.nodes.length) return graph;
  const nodes = [...graph.nodes];
  const [moved] = nodes.splice(index, 1);
  if (moved !== undefined) nodes.splice(target, 0, moved);
  return { ...graph, nodes };
}

function clearEmptyPorts(node: JourneyNode): JourneyNode {
  const next: Record<string, unknown> = { ...node };
  for (const port of ['next', 'then', 'otherwise'] as const) {
    if (next[port] === undefined || next[port] === '') delete next[port];
  }
  if (next['params'] === undefined) delete next['params'];
  if (next['seconds'] === undefined) delete next['seconds'];
  return next as unknown as JourneyNode;
}

/**
 * The draft lives in the journey's own `settings` field as JSON text — the field is free-form, appears in
 * the detail layout, and no server code reads it, so a draft needs no new table and no migration. Published
 * versions are separate immutable rows and are never written from here.
 */
export function parseDraft(settings: unknown): { graph: JourneyGraph | null; unreadable: boolean } {
  if (settings === null || settings === undefined || settings === '') return { graph: null, unreadable: false };
  const text = typeof settings === 'string' ? settings : JSON.stringify(settings);
  try {
    const parsed = JSON.parse(text) as unknown;
    const graph = (parsed as { graph?: unknown })?.graph;
    if (graph === undefined || typeof graph !== 'object') return { graph: null, unreadable: false };
    const candidate = graph as { start?: unknown; nodes?: unknown };
    if (typeof candidate.start !== 'string' || !Array.isArray(candidate.nodes)) {
      return { graph: null, unreadable: true };
    }
    return { graph: { start: candidate.start, nodes: candidate.nodes as JourneyNode[] }, unreadable: false };
  } catch {
    return { graph: null, unreadable: true };
  }
}

export function serializeDraft(graph: JourneyGraph): string {
  return JSON.stringify({ graph });
}
