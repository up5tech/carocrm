/**
 * BPM engine (PLAN §36) — process definitions, validation and the state machine that walks them.
 *
 * Pure by design: no database, queue, network or Nest imports. The API owns authoring and
 * advancement; the worker fires timers and runs dispatched actions; both drive this package.
 */
export * from './advance/index.js';
export * from './errors/index.js';
export * from './shape.js';
export * from './types/index.js';
export * from './validation/index.js';
