import type { Provider, Type } from "@nestjs/common";

import { DocumentController } from "./document.controller.js";
import { DocumentTemplateService } from "./document-template.service.js";

/**
 * The `document` module — the kernel-owned way a record becomes a document.
 *
 * Templates are records in the generic store, so the Entity Engine keeps CRUD, ACL, audit, stream and
 * import/export for them, and rendering is `@carocrm/document`, a pure package the API process and the
 * worker share. `DOCUMENT_CONTROLLERS` is registered **before** the generic `:entity` controller in
 * `AppModule`, so `document/action/preview` can never be read as a template id.
 */
export const DOCUMENT_CONTROLLERS: Type<unknown>[] = [DocumentController];

export const DOCUMENT_PROVIDERS: Provider[] = [DocumentTemplateService];

export { DocumentController } from "./document.controller.js";
export {
  type DocumentRenderResult,
  DocumentTemplateService,
} from "./document-template.service.js";
