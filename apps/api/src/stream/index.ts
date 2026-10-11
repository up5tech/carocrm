/**
 * Stream module barrel (PLAN §26) — integrator entry point.
 *
 * Wire into AppModule:
 *   controllers: [...STREAM_CONTROLLERS]   // MUST precede ENTITY_CONTROLLERS: this module
 *                                          // declares `/api/v1/:entityType/:entityId/...`
 *                                          // routes that the generic `:entity` wildcard owns
 *   providers:   [...STREAM_PROVIDERS]
 *
 * Record-update capture follows the same kernel-hook seam as audit:
 *   registerStreamUpdateHook(app.get(KERNEL_HOOKS_TOKEN), app.get(StreamUpdateHookService))
 *
 * The default STREAM_METADATA_LOOKUP disables generated Update items; the integrator
 * supplies the entity field definitions, e.g.
 *   { provide: STREAM_METADATA_LOOKUP, inject: [METADATA_STORE],
 *     useFactory: (store) => (entity: string) => store.registry.getEntity(entity)?.fields }
 */
import type { Provider, Type } from '@nestjs/common';

import { NoteController, NotificationController, StreamController } from './stream.controller.js';
import { StreamService } from './stream.service.js';
import type { StreamEntityMetadataLookup } from './stream-hooks.js';
import { STREAM_METADATA_LOOKUP, StreamUpdateHookService } from './stream-hooks.js';

export { NoteController, NotificationController, StreamController } from './stream.controller.js';
export type {
  CreateStreamItemInput,
  StreamItemDto,
  StreamItemType,
  StreamListOptions,
  StreamUserDto,
} from './stream.service.js';
export { STREAM_ITEM_TYPES, StreamService } from './stream.service.js';
export type {
  StreamEntityMetadataLookup,
  StreamFieldDefinitions,
  StreamUpdateHookLike,
} from './stream-hooks.js';
export { registerStreamUpdateHook, STREAM_METADATA_LOOKUP, StreamUpdateHookService } from './stream-hooks.js';

export const STREAM_PROVIDERS: Provider[] = [
  // Default: no entity metadata ⇒ no generated Update items.
  { provide: STREAM_METADATA_LOOKUP, useFactory: (): StreamEntityMetadataLookup => () => undefined },
  StreamService,
  StreamUpdateHookService,
];

export const STREAM_CONTROLLERS: Type<unknown>[] = [NoteController, StreamController, NotificationController];
