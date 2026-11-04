import { describe, expect, it } from 'vitest';

import {
  emptyGraph,
  insertAfter,
  type JourneyGraph,
  moveNode,
  parseDraft,
  portsFor,
  removeNode,
  serializeDraft,
  setPort,
} from './journeyGraph.js';

/**
 * Phase 19-MA.12 — the editor's graph operations.
 *
 * These are the only decisions the screen makes on its own, so they are tested on their own: a wrong
 * re-point here is a journey that silently loses a branch before it ever reaches the server. Everything
 * about legality stays the server's answer (`action/journey/:id/validate`), which is tested in
 * `apps/api/test/marketing-automation-journey.test.ts`.
 */

const chain = (): JourneyGraph => ({
  start: 'start',
  nodes: [
    { id: 'start', type: 'start', next: 'send' },
    { id: 'send', type: 'action', action: 'sendEmail', next: 'end' },
    { id: 'end', type: 'end' },
  ],
});

describe('journey graph editing', () => {
  it('starts a journey with one start node and nothing else', () => {
    const graph = emptyGraph();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.start).toBe('start');
    expect(graph.nodes[0]?.type).toBe('start');
  });

  it('inserts a step into the chain instead of appending it to the end', () => {
    const next = insertAfter(chain(), 'send', 'wait');
    const send = next.nodes.find((node) => node.id === 'send');
    const inserted = next.nodes.find((node) => node.type === 'wait');
    expect(send?.next).toBe(inserted?.id);
    expect(inserted?.next).toBe('end');
    expect(next.nodes).toHaveLength(4);
  });

  it('gives a branch node no linear continuation', () => {
    const next = insertAfter(chain(), 'send', 'condition');
    const inserted = next.nodes.find((node) => node.type === 'condition');
    expect(inserted?.next).toBeUndefined();
    expect(portsFor('condition')).toEqual(['then', 'otherwise']);
  });

  it('names a repeated node uniquely', () => {
    const once = insertAfter(chain(), 'send', 'wait');
    const twice = insertAfter(once, 'send', 'wait');
    const waits = twice.nodes.filter((node) => node.type === 'wait').map((node) => node.id);
    expect(new Set(waits).size).toBe(waits.length);
  });

  it('re-points the predecessors at where the removed node was going', () => {
    const withoutSend = removeNode(chain(), 'send');
    expect(withoutSend.nodes.map((node) => node.id)).toEqual(['start', 'end']);
    expect(withoutSend.nodes.find((node) => node.id === 'start')?.next).toBe('end');
  });

  it('leaves a branch that ended at the removed node without a target, for the validator to report', () => {
    const branched: JourneyGraph = {
      start: 'start',
      nodes: [
        { id: 'start', type: 'start', next: 'gate' },
        { id: 'gate', type: 'condition', then: 'drop', otherwise: 'end' },
        { id: 'drop', type: 'action', action: 'notify' },
        { id: 'end', type: 'end' },
      ],
    };
    const withoutDrop = removeNode(branched, 'drop');
    const gate = withoutDrop.nodes.find((node) => node.id === 'gate');
    expect(gate?.then).toBeUndefined();
    expect(gate?.otherwise).toBe('end');
  });

  it('moves the start pointer when the start node itself is removed', () => {
    const withoutStart = removeNode(chain(), 'start');
    expect(withoutStart.start).toBe('send');
    expect(withoutStart.nodes.some((node) => node.id === 'start')).toBe(false);
  });

  it('reorders rows without touching the flow', () => {
    const moved = moveNode(chain(), 'end', -1);
    expect(moved.nodes.map((node) => node.id)).toEqual(['start', 'end', 'send']);
    expect(moved.nodes.find((node) => node.id === 'start')?.next).toBe('send');
    expect(moveNode(chain(), 'start', -1).nodes.map((node) => node.id)).toEqual(['start', 'send', 'end']);
  });

  it('clears a port that is set to nothing, rather than storing an empty target', () => {
    const cleared = setPort(chain(), 'send', 'next', '');
    expect(cleared.nodes.find((node) => node.id === 'send')?.next).toBeUndefined();
    const repointed = setPort(chain(), 'send', 'next', 'start');
    expect(repointed.nodes.find((node) => node.id === 'send')?.next).toBe('start');
  });

  it('reads back exactly what it wrote, and refuses to invent a graph from junk', () => {
    const graph = chain();
    const parsed = parseDraft(serializeDraft(graph));
    expect(parsed.unreadable).toBe(false);
    expect(parsed.graph).toEqual(graph);

    expect(parseDraft(undefined)).toEqual({ graph: null, unreadable: false });
    expect(parseDraft('not json at all')).toEqual({ graph: null, unreadable: true });
    expect(parseDraft(JSON.stringify({ graph: { nodes: 'nope' } })).unreadable).toBe(true);
    expect(parseDraft(JSON.stringify({ somethingElse: true }))).toEqual({ graph: null, unreadable: false });
  });
});
