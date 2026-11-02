# plans/SPEC.md — Đặc tả CaroCRM

| | |
|---|---|
| **Phiên bản** | 1.0.0 |
| **Ngày** | 2026-11-02 |
| **Phạm vi** | Toàn hệ thống (as-built) + đặc tả tầng AI CRM v2 |
| **Trạng thái** | §1–§7: đã triển khai. §9.2 + §9.6: **đã triển khai 2026-11-02** (phase 19-CHAT.20, 19-CHAT.21). §9.3–§9.5, §9.7–§11: đề xuất, đã chia thành phase **19-CHAT.22 → 19-CHAT.24** trong `plans/PLAN_Phase_19_CRM_Chat.md` §17, **chưa triển khai**. |
| **Ngôn ngữ** | Prose tiếng Việt; định danh, khoá tool, đường dẫn, schema giữ nguyên tiếng Anh. |

---

## 0. Cách đọc tài liệu

Ba tài liệu, ba vai trò khác nhau — không thay thế nhau:

| Tài liệu | Vai trò | Khi nào đọc |
|---|---|---|
| `plans/PLAN.md` | Roadmap + kiến trúc tham chiếu. Mô tả **ý định**. | Trước khi thiết kế một subsystem mới. |
| `plans/SPEC.md` (file này) | Đặc tả **as-built** của hệ thống đang chạy, cộng đặc tả phần sẽ xây. | Trước khi sửa hành vi đã có; khi onboarding. |
| `AGENTS.MD` | Luật vận hành: an toàn DB, chính sách test, quy ước migration. | Trước mọi thao tác có ghi. |

**Thứ tự ưu tiên khi mâu thuẫn:** code > `SPEC.md` > `PLAN.md`. Nếu SPEC lệch code, SPEC là bản sai và phải sửa — trừ khi độ lệch là chủ ý, khi đó ghi rõ trong §12.

**Mọi con số trong tài liệu này được đếm từ repo tại 2026-11-02**, không lấy từ PLAN.md.

---

## 1. Định nghĩa sản phẩm

CaroCRM là bản tái triển khai EspoCRM bằng NestJS + TypeScript trên PostgreSQL, theo kiểu **modular monolith, metadata-driven**. Mục tiêu là tái tạo *hành vi sản phẩm* và *khái niệm kiến trúc* đã được tài liệu hoá, không dịch từng dòng PHP.

### 1.1 Nguyên tắc bất biến

1. **Metadata là subsystem hạng nhất.** Entity, field, relation, layout đều là dữ liệu; engine đọc metadata để phục vụ CRUD, tìm kiếm, ACL và UI.
2. **Mọi truy cập dữ liệu đi qua Entity Engine.** Không controller, không module nào viết SQL trực tiếp lên `entity_records` để né validation/ACL/audit.
3. **ACL ở mọi tầng.** Record-level và field-level áp dụng cho cả người dùng thật lẫn agent AI. Một agent run **không** phải người dùng nâng quyền.
4. **Domain sở hữu luật nghiệp vụ của mình.** Sales sở hữu vòng đời báo giá; ServiceDesk sở hữu SLA; AIAgents sở hữu runtime agent. Module khác gọi qua service công khai, không đọc bảng riêng.
5. **Không microservices.** Ranh giới là thư mục kernel + DI, không phải mạng.

### 1.2 Không thuộc phạm vi

Port cấu trúc class PHP; sao chép schema upstream; chạy extension PHP; microservices; mọi tính năng enterprise trước khi nền tảng ổn định.

---

## 2. Hình dạng hệ thống (as-built)

| Hạng mục | Hiện trạng |
|---|---|
| Runtime | Node `>=22`, pnpm `10.0.0` |
| Backend | NestJS + Fastify, một `AppModule` duy nhất, provider spread từ barrel từng module |
| CSDL | PostgreSQL + Kysely; `entity_records` (JSONB) + bảng domain riêng |
| Frontend | React + Vite + antd; hai shell: workspace và portal |
| Async | Redis + BullMQ (worker riêng: `apps/worker`) |
| i18n | `en` + `vi`; 11 catalog theo miền trong `i18n/<locale>/` — `core`, `crm`, `web`, `sales`, `marketing`, `leadscore`, `esignature`, `omnichannel`, `voice`, `advancedintegrations`, `errors` |
| Migration | 86 file, mới nhất `086_phase22_outbox_correlation.sql`, additive, theo thứ tự tên file |
| Workspace package | 19 package trong `packages/` (`acl`, `entity-engine`, `query-engine`, `metadata`, `reports`, `bpm`, `workflow`, `document`, `mail`, `files`, `search`, `core`, `ui-schema`, `api-client`, `extension-sdk`, `jobs`, `formula`, `docs`, `test-kit`) |
| App | `api`, `web`, `worker` (+ `graphify-out` là output sinh tự động) |
| Test | 215 file test API (`apps/api/test`), 39 test trong `packages/`, 7 test web, 22 spec Playwright |
| Entity metadata | 115 entity nghiệp vụ + tài liệu (số đo từ log boot `metadata loaded entities:115`), khai báo trong `database/seed-metadata.ts` (literal hoặc factory) |

### 2.1 Cổng kiểm

`pnpm ci:gate` = `lint` → `lint:arch` → `typecheck` → `build` → `ci:migrations` → `test:ci` → `test:worker` → `test:web` → `ci:secrets`.

`pnpm lint` chạy `lint:ui` trước eslint. `pnpm lint` toàn repo đỏ trên `.agents/**` (vendored) — phạm vi hợp lệ là `npx eslint apps packages e2e database scripts modules`.

---

## 3. Kernel nền

| Subsystem | Trách nhiệm | Bất biến đáng nhớ |
|---|---|---|
| Entity Engine | CRUD, list, related, aggregate, mass action trên mọi entity metadata | `entity_records` có `created_at` + `modified_at`, **không** có `updated_at`; `/Related` là **một** predicate union (`anyOf`: khớp attr **hoặc** id trong `entity_links`) — không phân trang rồi ghép |
| Metadata Engine | Hợp nhất metadata seed + extension; cache; validate | Entity/field lạ là lỗi 4xx, không im lặng bỏ qua |
| Query Engine | Dịch filter DSL sang SQL có tham số | `ON CONFLICT` không suy ra được partial unique index trừ khi lặp lại predicate |
| ACL | Role, field permission, record predicate | Entity ACL `delete: 'no'` chặn cả admin — test phải xoá theo id |
| Stream | Timeline, note, follow, notification | Mọi post đi qua `assertParentAccess` — quyền của bản ghi cha quyết định |
| Hooks / Events | `beforeValidate` → `beforeSave` → `afterSave`; domain event + outbox | Luật liên bản ghi đặt trên `beforeValidate` để CRUD generic và domain command cùng được validate |
| Jobs | BullMQ + cron | Claim phải là **lease** (đẩy hạn về trước), không phải bump version |
| Audit | Lịch sử thay đổi theo field | — |
| i18n | Catalog + resolution + fallback | `KEY_RE` cấm dấu gạch nối trong segment khoá |
| Extensions | Manifest, lifecycle, sandbox | — |

### 3.1 Lỗi và HTTP

`AppError` → `GlobalExceptionFilter`. `ValidationError` → **422** với body `{ error: { code, message, details } }`.

> **Bẫy đã gặp:** hook/plugin Fastify (`@fastify/rate-limit`, body parser, multipart) ném `Error` trơn chỉ có `statusCode`. `GlobalExceptionFilter` mà chỉ xử lý `AppError`/`HttpException` sẽ biến 429/413 thành 500.

### 3.2 Ranh giới kiến trúc

`pnpm lint:arch` chặn **shared core → domain**. Chiều domain → domain hiện là DAG: `ai-agents`, `sales`, `projects`, `service-desk`, `marketing-automation`, `customer-success` không import domain nào.

Đây là ràng buộc **quan trọng cho §9**: không được để `ai-agents` import `crm-chat`, vì `crm-chat` đã import `ai-agents` — sẽ tạo chu trình và phá vỡ bất biến DAG đang được tài liệu hoá.

---

## 4. Danh mục module (as-built)

### 4.1 Kernel domain

| Module | id | API prefix | Route | Bảng riêng |
|---|---|---|---|---|
| AI Agents | `AIAgents` | `/api/v1/AIAgents` | `/ai-agents` | `ai_agent_*`, `ai_provider_*` |
| CRM Chat | `CRMChat` | `/api/v1/CRMChat` | `/crm-chat` | `crm_chat_citations`, `crm_chat_feedback`, `crm_chat_prompts` |
| Sales | `Sales` | `/api/v1/Sales` | màn entity (`Quote`, `SalesOrder`, `Invoice`, …) | bảng tài liệu + kho + thanh toán |
| Projects | `Projects` | `/api/v1/Project`, `/api/v1/ProjectTask` | `/Project/:id/{plan,board,gantt,members,settings}` | `project_*` |
| Customer Success | `CustomerSuccess` | `/api/v1/CustomerSuccess` | dashlet + entity `CustomerSuccessProfile` | `cs_*` |
| Service Desk | `ServiceDesk` | `/api/v1/ServiceDesk` | `/Case/dashboard` | `case_*`, `sla_*`, `csat_*` |
| Marketing Automation | `MarketingAutomation` | `/api/v1/MarketingAutomation` | entity `Campaign` + `/marketing/preferences` | `marketing_*` |
| Lead Score | `LeadScore` | `/api/v1/LeadScore` | `/lead-score` | `lead_score_*`, `lead_conversion_*` |
| E-Signature | `ESignature` | `/api/v1/ESignature` (+ `/requests`, `/templates`) | `/esignature` | `esignature_*` |
| Voice & Communications | `VoiceCommunications` | `/api/v1/VoiceCommunications` | `/voice-communications`, `/voice-inbox` | bảng call/message riêng |
| Omnichannel | `Omnichannel` | `/api/v1/Omnichannel`, `/api/v1/Omnichannel/chat` | `/omnichannel` | `omnichannel_*` |
| Advanced Integrations | `AdvancedIntegrations` | `/api/v1/AdvancedIntegrations` | `/advanced-integrations` | — |
| Portal | `Portal` | `/api/v1/Portal`, `/api/v1/PortalRole` | `/portal/*`, `/chat`, `/csat` | `portal_*` |
| BPM | `Processes` | `/api/v1/Process`, `/api/v1/ProcessInstance`, `/api/v1/ProcessTask` | `/admin/processes`, `/processes` | `bpm_*` |
| Workflows | `Workflows` | `/api/v1/Workflow`, `/api/v1/WorkflowRun` | `/admin/workflows` | `workflow_*` |

Prefix dùng **số ít** cho các module này (`Project`, `Workflow`, `Report`) — không phải số nhiều. Đây là điểm dễ viết sai khi thêm client mới.

### 4.2 Nền tảng / admin

`acl`, `admin-panel` (`/admin/*`), `attachment`, `audit` (`/admin/audit-log`), `auth` (`/login`), `calendar` (`/calendar`), `docs` (`/docs`), `document` (`/DocumentTemplate/*`), `email` (`/EmailTemplate/*`), `entity` (API `/api/v1/:entity`; web `/:entity`, `/:entity/:id`, …), `events`, `extensions` (`/admin/extensions`), `health`, `hooks`, `i18n`, `jobs` (`/admin/jobs`), `logic`, `preferences`, `reports` (`/reports`), `search` (`/search`, `/dashboards`), `settings` (`/admin/settings`), `setup-checklist`, `stream` (`/stream`), `tasks` (`/tasks`).

Mọi entity metadata có sẵn API CRUD + list + related dưới `/api/v1/:entity` và màn hình generic — đây là lý do một module mới thường **không cần** controller riêng.

---

## 5. Mô hình dữ liệu

Entity metadata được nhóm theo miền. Tên là **chính xác** như trong `seed-metadata.ts`.

| Miền | Entity |
|---|---|
| CRM lõi | `Account`, `Contact`, `Lead`, `Opportunity`, `Task`, `Call`, `Meeting`, `Reminder`, `Email`, `EmailTemplate` |
| Tài liệu | `DocumentTemplate` |
| Bán hàng | `Product`, `ProductCategory`, `PriceBook`, `PriceBookEntry`, `PriceRule`, `Supplier`, `SupplierProductPrice`, `TaxClass`, `TaxCode`, `TaxRate`, `TaxRule`, `PaymentTermProfile`, + entity tài liệu sinh từ factory (`Quote`, `QuoteItem`, `SalesOrder`, `Invoice`, `CreditNote`, `DeliveryOrder`, `ReturnOrder`, `PurchaseOrder`, …) |
| Kho | `Warehouse`, `InventoryTransaction`, `InventoryAdjustment`, `TransferOrder`, `TransferOrderItem`, `InventoryReservation`, `InventoryBatch`, `InventorySerial` |
| Thanh toán | `Payment`, `PaymentAllocation`, `PaymentRequest`, `PaymentProviderEventLog`, `Subscription`, `SubscriptionPeriod`, `BillCreditAllocation`, `CreditNoteAllocation`, `WriteOff` |
| Dự án | `Project`, `ProjectCategory`, `ProjectBoard`, `ProjectBoardStage`, `ProjectRole`, `ProjectMember`, `ProjectGroup`, `ProjectTask`, `ProjectTaskCollaborator`, `ProjectTaskDependency` |
| Customer Success | `CustomerSuccessProfile`, `CustomerSuccessHealthSnapshot`, `CustomerSuccessPlan`, `CustomerSuccessGoal`, `CustomerSuccessRisk`, `CustomerSuccessPlaybookTemplate`, `CustomerSuccessPlaybookRun`, `CustomerSuccessPlaybookStepRun`, `CustomerSuccessReview` |
| Service Desk | `Case`, `CaseQueue`, `QueueMember`, `RoutingRule`, `CaseTransition`, `CaseAssignment`, `BusinessCalendar`, `SLAPolicy`, `CaseSLAClock`, `KnowledgeCategory`, `KnowledgeArticle`, `CsatSurvey` |
| Marketing | `Campaign`, `CampaignTransition`, `TargetList`, `TargetListEntry`, `MarketingConsent`, `MarketingConsentEvent`, `MarketingSuppression`, `MarketingPublicToken`, `MarketingAudienceSnapshot`, `MarketingTemplateRevision`, `MarketingSend`, `MarketingSendTransition`, `MarketingJourney`, `MarketingJourneyVersion`, `MarketingJourneyEnrollment`, `MarketingJourneyStepExecution` |
| Lead Score | `LeadScoreModel`, `LeadScoreRule`, `LeadScoreEvaluation`, `LeadScoreInsight`, `LeadConversionOperation` |

---

## 6. Bề mặt web và quy ước UI

### 6.1 Route

Ba nhóm: **workspace** (sau đăng nhập), **portal** (`/portal/*`, khách hàng), **public** (`/chat`, `/csat`, `/marketing/preferences`). Route entity generic là `/:entity`, `/:entity/:id`, `/:entity/create`, `/:entity/:id/edit`, `/:entity/board` — mọi entity metadata có màn hình mà không cần code riêng.

### 6.2 Quy ước bắt buộc (được `pnpm lint:ui` cưỡng chế)

| Luật | Vì sao |
|---|---|
| Mọi khoá `t('…')` phải tồn tại trong `i18n/en` (đếm cả `key_one`/`key_other`) | Khoá thiếu render ra chính khoá đó |
| Không `.slice(0, 19)` cho timestamp | Cắt chuỗi ISO là lỗi thời gian |
| Không `<Empty>` trần | Chỉ dùng `EmptyState` |
| Không `<a href="/…">` nội bộ | Phải dùng router link; tải file dưới `/api/` được miễn |

`EmptyState` là empty state duy nhất: `title` trên `hint`, `variant` ∈ `no-records | no-results | filtered | denied`, `action`/`children` cho nút sửa, `size="compact"` cho panel bản ghi. Khoá là `core.empty*` — **không** phải `core.common.empty*`.

Thời gian đi qua `formatDateTime` / `formatClock` / `formatRelative`. `AppErrorBoundary` mount hai lần (root + per-route). `OfflineBanner` đọc `onlineManager` của React Query — không thêm listener `navigator.onLine` thứ hai.

### 6.3 Khung workspace

`/crm-chat` và `/voice-inbox` dùng chung bộ CSS trong `carocrm.css`: `carocrm-workspace-*` (head, rail, toolbar, body, dock) + `carocrm-rail-*` + `carocrm-convo-*`. Chỉ thêm prefix riêng cho phần đặc thù module (`carocrm-chat-*`, `carocrm-inbox-*`).

Chiều cao khung là `calc(100vh - 235px)` = 70 header + 48 content padding + 46 page head + 14 gap + 56 footer. Đổi chiều cao page head thì phải đổi số này.

---

## 7. Tầng AI (as-built)

### 7.1 AIAgents — runtime

| Khái niệm | Giá trị |
|---|---|
| Version / loadOrder | `1.0.0` / `390` |
| Vòng đời agent | `draft → published → paused → retired`; sửa cấu hình published = version mới bất biến |
| Effect class | `read`, `low_write`, `material_write`, `high_impact` |
| Ma trận duyệt mặc định | `read` không · `low_write` không · `material_write` **có** · `high_impact` **có** |
| Giới hạn mỗi run | steps, model calls, tool calls, token, cost USD, elapsed, retries, output tokens, temperature |
| Memory | `none` hoặc `conversation`; Chat **bắt buộc** `conversation` |
| Nhà cung cấp | gateway trừu tượng; adapter OpenAI-compatible, Anthropic, fake |
| Kiểm soát | quota, budget, kill switch `safety.globalExecutionPaused`, evaluation suite |

Mỗi tool call chạy trong `scope.runAs(actorUserId)` — quyền của **người khởi chạy**, không phải quyền hệ thống.

### 7.2 Tool registry — 12 tool hiện có

Khai báo trong `apps/api/src/ai-agents/ai-agent-tools.ts` (trừ `crm_cross_module`, do `crm-chat` tự đăng ký — §9.1 luật 6). Đăng ký bằng code tin cậy; model chỉ chọn **key** + **arguments**, không bao giờ chọn handler, URL, bảng, SQL hay luật quyền.

| # | key | effect | Duyệt | `entityScopes` | Cap | Từ |
|---|---|---|---|---|---|---|
| 1 | `crm_search_records` | read | không | 10 entity đọc được | 32 KiB / 10 s | 19-AI.6 |
| 2 | `crm_read_record` | read | không | 10 entity | 24 KiB / 10 s | 19-AI.6 |
| 3 | `crm_list_related` | read | không | 10 entity | 32 KiB / 10 s | 19-AI.6 |
| 4 | `crm_record_summary` | read | không | 10 entity | 16 KiB / 10 s | 19-AI.6 |
| 5 | `docs_search` | read | không | — | 16 KiB / 5 s | 19-AI.6 |
| 6 | `docs_read_page` | read | không | — | 16 KiB / 5 s | 19-AI.6 |
| 7 | `crm_actor_context` | read | không | — | 4 KiB / 5 s | 19-CHAT.21 |
| 8 | `crm_aggregate` | read | không | 10 entity | 16 KiB / 10 s | 19-CHAT.21 |
| 9 | `crm_list_activities` | read | không | `Call`, `Meeting`, `Task` | 24 KiB / 10 s | 19-CHAT.21 |
| 10 | `crm_cross_module` | read | không | `Account`, `Opportunity`, `Project`, `Contact` | 32 KiB / 10 s | 19-CHAT.21 |
| 11 | `crm_create_task` | low_write | không | `Task` | 8 KiB / 10 s | 19-AI.6 |
| 12 | `crm_update_record_fields` | material_write | **có** | 6 entity | 8 KiB / 10 s | 19-AI.6 |

Ba tool đọc mới (`19-CHAT.21`) đóng đúng ba lỗ hổng của §8:

| Tool | Trả lời câu hỏi gì | Cơ chế chống bịa |
|---|---|---|
| `crm_aggregate` | "bao nhiêu", "tổng giá trị", "theo stage", "theo owner" | `EntityCrudService.aggregate()` — SQL, có record predicate; quét ≤ 100 nhóm rồi cắt theo `maxGroups`, đánh dấu `truncated` |
| `crm_list_activities` | "hôm nay tôi có gì", "account này có cuộc gọi nào" | `scope: mine` resolve từ `context.actorUserId` (model không truyền được user id); `scope: record` đọc `entity_links` rồi list qua Entity Engine |
| `crm_actor_context` | "của tôi" là ai, hôm nay là ngày nào, ở múi giờ nào | `AIAgentActorDirectoryService` — cùng nguồn với system prompt (§7.6) |

Kỳ hạn tương đối (`this_quarter`, `last_month`, `rolling:30d`, …) do server resolve trong `apps/api/src/ai-agents/ai-agent-periods.ts`, không phải model tự tính ngày. Kết quả trả kèm `period: { label, from, to, timezone }` để câu trả lời nêu được khoảng thời gian thật.

**10 entity đọc được:** `Account`, `Contact`, `Lead`, `Opportunity`, `Case`, `Task`, `Project`, `Campaign`, `CustomerSuccessProfile`, `Quote`.

**6 entity ghi được** (chỉ `description`, và `status` trên Lead/Case/Task): `Account`, `Contact`, `Lead`, `Opportunity`, `Case`, `Task`.

### 7.3 Agent template

| key | Mô tả | Tool | Memory |
|---|---|---|---|
| `account-briefing` | Tóm tắt một account: người liên hệ, cơ hội mở, bước tiếp theo | 4 tool đọc CRM | `none` |
| `product-help-assistant` | Trả lời "cách dùng tính năng X" từ handbook, có trích dẫn | `docs_search`, `docs_read_page` | `conversation` |

Chat không tự chọn agent: quản trị viên lưu **key** của một profile đã publish.

### 7.4 CRMChat — trải nghiệm

| Hạng mục | Giá trị |
|---|---|
| Version / loadOrder | `1.1.0` / `395` |
| Capability | `use`, `manage`, `delete`, `feedback`, `prompts`, `admin` |
| Feature flag | `workspace` (mặc định **on**), `readTools`, `helpRetrieval`, `actionProposals`, `feedback`, `conversationSearch` (mặc định **off**) |
| Giới hạn mặc định | `maxMessageChars` 8000, `maxContextRefs` 5, `maxActiveTurnsPerUser` 1, `maxConversationsPerUser` 200, `turnTimeoutSeconds` 180 |
| Bảng riêng | `crm_chat_citations`, `crm_chat_feedback`, `crm_chat_prompts` |
| Hội thoại / tin nhắn | Thuộc `AIAgents` (`ai_agent_conversations`, `ai_agent_messages`) — Chat không sở hữu |
| Trạng thái sẵn sàng | `not-configured` → `unresolvable` → `not-found` → `not-published` → `execution-disabled` → `execution-paused` → `memory-disabled` → `agent-memory-off` → `ready` |

**4 chip gợi ý** (`apps/web/src/pages/CRMChatPage.tsx:264-269`), hardcode, không phụ thuộc tool:

| Chip | Khoá i18n |
|---|---|
| Tóm tắt cơ hội đang mở của tôi | `web.crmChat.suggestion.opportunities` |
| Account nào không có hoạt động tháng này? | `web.crmChat.suggestion.staleAccounts` |
| Các deal chốt trong quý này | `web.crmChat.suggestion.closingQuarter` |
| Soạn email follow-up cho cuộc họp gần nhất | `web.crmChat.suggestion.followUpEmail` |

### 7.5 Bất biến an toàn của tầng AI

1. Tool chạy qua Entity Engine hoặc domain service — ACL, validation, audit, hook áp dụng y như một request của người dùng.
2. Nội dung bản ghi trả về mang marker `untrusted: true`; system prompt nói rõ đó là **dữ liệu**, không phải chỉ thị.
3. Tool ghi bắt buộc `preview` + quyết định của con người; quyết định **revalidate** target, ACL, field right, hash proposal, hạn dùng và **version** bản ghi.
4. Citation được **đọc lại** dưới ACL hiện tại trước khi render; bản ghi đã bị thu hồi thì không có citation.
5. Không có tool SQL thô, shell, filesystem hay HTTP tuỳ ý — và không được thêm nếu chưa có thiết kế sandbox được review riêng.
6. `idempotencyKey` suy ra từ run + step + tool-call identity.

### 7.6 Danh tính người khởi chạy trong system prompt (đã triển khai 2026-11-02)

`apps/api/src/ai-agents/ai-agent-actor.ts` dựng khối "Acting user" trong system message: `id`, `name`, `role`, `teams` và một câu nói rõ id này là thứ để lọc (`assignedUserId`). `AIAgentRunService.actorContext()` đọc `users` + `users_teams` một lần cho mỗi lần thực thi run, không phải mỗi bước.

| Quy tắc | Lý do |
|---|---|
| Khối vắng mặt khi run không có actor | Run do hệ thống khởi tạo vẫn chạy; thiếu actor không phải lỗi |
| Mọi giá trị đi qua `promptSafe()` | Tên người dùng và tên team là văn bản do người dùng kiểm soát, nằm trong **system** message — không được phép mở dòng mới |
| Dòng `- id: <id>` có định dạng cố định | `FakeProviderAdapter.actorIdFromSystem()` đọc đúng dòng này; đổi định dạng là đổi cả hai nơi |
| Id là của người **khởi chạy**, không phải người bấm execute | `row.initiated_by_user_id`; run xếp hàng do A tạo, B thực thi vẫn là "của A" |

Đây là thứ khiến câu hỏi dạng "của tôi" trả lời được **bằng tool hiện có** — `crm_search_records` nhận `criteria: [{ field: "assignedUserId", operator: "equals", value: "<id>" }]`. Không cần tool mới cho trường hợp này.

---

## 8. Phân tích khoảng trống so với tiêu chí AI CRM

### 8.1 Bảy họ năng lực

| Họ năng lực | Trạng thái | Bằng chứng |
|---|---|---|
| Truy vấn & đọc bản ghi | Đã có | 4 tool đọc generic |
| Tổng hợp, so sánh, dự báo | Đã có (19-CHAT.21) | `crm_aggregate` — `count/sum/avg/min/max` + một `groupBy`, kỳ hạn server-side. Chưa có dự báo (forecast) thật |
| Bối cảnh "của tôi" | Đã có (§7.6 + 19-CHAT.21) | Prompt mang `id`/`teams`; `crm_actor_context` thêm múi giờ + "hôm nay" |
| Hoạt động & timeline | Đã có một phần (19-CHAT.21) | `crm_list_activities` cho `Call`/`Meeting`/`Task`, `scope: mine \| record` (chỉ Account/Contact). `Email` và Stream vẫn ngoài registry |
| Ghi lại kết quả công việc | Một phần | Chỉ `crm_create_task`, task không gắn bản ghi cha |
| Trí tuệ module (score/health/SLA) | **Chưa có** | Service có, tool không |
| Duyệt & kiểm toán | Đã có | `ai_agent_approvals`, audit, evaluation |

### 8.2 Bốn chip: hai câu đã trả lời được, hai câu chưa

| Chip | Trạng thái | Nguyên nhân gốc |
|---|---|---|
| "Cơ hội đang mở **của tôi**" | **Đã sửa (§7.6)** | Trước: `systemPrompt()` chỉ nhận `agentName` + `config`, không có actor. Nay prompt mang `id` + `teams`, và `crm_search_records` lọc được `assignedUserId` — có test end-to-end chứng minh chuỗi này. |
| "Deal chốt quý này" | **Đã sửa (19-CHAT.21)** | `crm_aggregate` nhận `period: "this_quarter"` + `dateField: "closeDate"`; server resolve kỳ hạn trong múi giờ người hỏi và trả kèm `period.label/from/to` để câu trả lời nêu đúng khoảng. Model không còn tự tính ngày. |
| "Account không có hoạt động tháng này" | Chưa (19-CHAT.23) | `crm_list_activities` trả *có* hoạt động, nhưng câu hỏi cần phép phủ định trên `stream_items` — `crm_stale_records` mới làm được. |
| "Soạn email follow-up" | Chưa (19-CHAT.22) | `Email` không nằm trong `READABLE_ENTITIES`, không có tool soạn nháp → model viết chay. `crm_draft_email` là việc của đợt ghi. |

### 8.3 Năm khiếm khuyết cấu trúc

| # | Khiếm khuyết | Bằng chứng | Hệ quả |
|---|---|---|---|
| D1 | ~~Không có tổng hợp~~ **đã sửa 19-CHAT.21** | `crm_aggregate` | "bao nhiêu", "tổng giá trị", "theo stage" nay là số từ SQL |
| D2 | ~~Năng lực có sẵn nhưng không expose~~ **đã sửa 19-CHAT.21** | `crm_cross_module` đăng ký từ `crm-chat` | Account-360 và project-delivery gọi được từ model; `CRMChatQueryService` vẫn chỉ REST (không cần) |
| D3 | Ghi không khép vòng | `CreateTaskArgumentsSchema` (`:184-192`) không có parent | Task tạo ra mồ côi, không gắn Account/Opportunity |
| D4 | `WRITABLE_FIELDS` quá hẹp | `:119-126` chỉ `description` + `status` | Không đổi được stage, owner, priority, closeDate |
| D5 | Chip không biết agent có tool gì | `assistant.tools` đã có trong payload (`types.ts:2781`) nhưng chỉ dùng cho drawer chẩn đoán | Chip hứa điều agent không làm được |

---

## 9. Đặc tả: AI CRM tool catalogue v2

> Đặc tả này **đã được chia thành phase** trong `plans/PLAN_Phase_19_CRM_Chat.md` §17: §9.6 → 19-CHAT.20 ✅, §9.2 → 19-CHAT.21 ✅, §9.3 + §9.5 → 19-CHAT.22, §9.4 → 19-CHAT.23, §9.7 → 19-CHAT.24. Khi hai tài liệu lệch nhau, plan là nơi ghi trạng thái thực thi; SPEC là nơi ghi lý do thiết kế.

### 9.1 Luật thiết kế cho mọi tool mới

1. **Schema kép.** Zod `inputSchema` (strict, từ chối field lạ) **và** `inputJsonSchema` viết tay — model không bao giờ thấy internals của Zod.
2. **`entityScopes` phải đăng ký.** `validateGrant` kiểm `metadata.registry.hasEntity(entity)`; entity không tồn tại làm grant không publish được.
3. **Cap bắt buộc.** `maxResultBytes` + `timeoutMs`; kết quả cắt ngắn, đánh dấu `truncated`.
4. **ACL qua service sở hữu.** Không tự viết predicate; gọi `EntityCrudService` / `entities.aggregate` (đã áp `acl.assertAccess` + `recordPredicate`).
5. **Actor do server quyết, không do model.** Tham số kiểu "của tôi" được resolve từ `context.actorUserId`; model không truyền `userId`.
6. **Chiều phụ thuộc.** Tool dùng shared-core (entity, metadata, reports, docs) khai báo trong `ai-agents`. Tool cần service của **domain khác** phải được domain đó **tự đăng ký** qua `AIToolRegistry.register()` tại bootstrap — không để `ai-agents` import ngược, vì `crm-chat` đã import `ai-agents` và DAG sẽ thành chu trình.
7. **`version` tăng khi đổi hành vi.** Tool đã publish mà đổi schema/handler = `version: '2'`, không sửa tại chỗ.
8. **Mỗi tool một eval case** trong `apps/api/test/crm-chat-evaluation.test.ts` + cập nhật assert catalogue (`ai-agent-runs.test.ts:389`).

### 9.2 Đợt 1 — nền tảng (read, không cần duyệt) — ✅ đã triển khai 2026-11-02 (19-CHAT.21)

Mở khoá phần lớn câu hỏi, rủi ro thấp nhất, không có đường ghi.

**As-built khác bản đề xuất ở ba chỗ, tất cả đều nhỏ hơn:**

| Chỗ | Đề xuất | Đã làm | Lý do |
|---|---|---|---|
| `crm_actor_context` | `{ userId, name, email, locale, timezone, isAdmin, teams }` | thêm `available`, `today`, `now` | "Hôm nay là ngày nào" là câu model sai nhiều nhất; trả luôn ngày địa phương rẻ hơn là để nó suy ra |
| `crm_aggregate` | `maxGroups` = số nhóm trả về | quét tới 100 nhóm, sort theo metric, cắt còn `maxGroups` | Store sắp theo khoá nhóm, nên "top N theo giá trị" cần quét rộng hơn rồi cắt; `truncated` nói rõ khi bị cắt |
| `crm_list_activities` | trả `related[]` cho từng dòng | trả `record` một lần ở cấp kết quả | `related` từng dòng là N+1; ai cần chi tiết thì gọi `crm_list_related` trên chính activity đó |

Kỳ hạn tương đối nằm ở `ai-agent-periods.ts` (thuần, 16 test, có trong `PURE_API_TESTS`), không nhét vào từng tool.

#### T1.1 `crm_actor_context`

```
label: "Read the acting user's context"
effectClass: read · requiresApproval: false · entityScopes: []
input: {}                                  // strict, không property nào
result: { userId, name, email, locale, timezone, isAdmin,
          teams: [{ id, name }] }
caps: 4 KiB · 5 s
```

Nguồn: `RequestScope` + đọc `users`/`teams`. Chỉ dữ liệu của chính người gọi; không lộ role của người khác.
**Nghiệm thu:** `userId` trả về bằng `run.initiated_by_user_id`; không có trường nào của user khác.

> Đây là tool *bổ trợ*; sửa gốc vẫn là §9.6 (đã xong). Cả hai đọc **cùng một** service — `AIAgentActorDirectoryService` — nên prompt và tool không thể mô tả cùng một người theo hai cách khác nhau.

#### T1.2 `crm_aggregate`

```
label: "Aggregate CRM records"
effectClass: read · requiresApproval: false · entityScopes: READABLE_ENTITIES
input: {
  entity: enum(READABLE_ENTITIES),
  metric: "count" | "sum" | "avg" | "min" | "max",
  field?: string,            // bắt buộc với sum/avg/min/max
  groupBy?: string,          // tối đa 1 chiều
  criteria?: [{field, operator, value}]   // ≤ 6, cùng allowlist với search
  order?: "asc" | "desc",
  maxGroups: 1..10 = 10
}
result: { entity, metric, field, groupBy,
          rows: [{ key, value }], total, truncated }
caps: 16 KiB · 10 s
```

Nguồn: `EntityCrudService.aggregate()` (`entity.service.ts:164`) — đã áp ACL record predicate. Giới hạn nhóm theo `MAX_REPORT_GROUPS`.
**Nghiệm thu:** "pipeline theo stage" trả ≤ 10 nhóm có tổng `amount`; người gọi không có quyền `Case: read` nhận lỗi/0, **không** nhận con số.

#### T1.3 `crm_list_activities`

```
label: "List activities"
effectClass: read · requiresApproval: false · entityScopes: [Call, Meeting, Task]
input: {
  kind: enum("Call","Meeting","Task"),
  scope: "mine" | "record",
  record?: { entity: enum(READABLE_ENTITIES), id: string },   // bắt buộc khi scope=record
  from?: ISO date, to?: ISO date,
  status?: enum("Planned","Held","Not Held"),
  maxSize: 1..25 = 10
}
result: { items: [{ id, name, dateStart, dateEnd, status,
                    related: [{ entity, id, label }] }], count }
caps: 24 KiB · 10 s
```

`scope: "mine"` resolve từ `context.actorUserId` — model không truyền user id. Bản ghi liên quan đọc qua `entity_links`.
**Nghiệm thu:** "hôm nay tôi có gì" chỉ trả hoạt động của người gọi; hoạt động của người khác không xuất hiện dù cùng team.

#### T1.4 `crm_cross_module`

```
label: "Analyse across modules"
effectClass: read · requiresApproval: false · entityScopes: [Account, Opportunity, Project, Contact]
input: { scenario: enum("account-360","opportunity-commercial",
                        "project-delivery","contact-service"),
         rootId: string }
result: { scenario, label, rootEntity, rootId, steps:[...],
          partial, warnings, computedAt }
caps: 32 KiB · 10 s
```

Nguồn: `CRMChatCrossModuleService.run()` — **không viết logic mới**. Đăng ký từ phía `crm-chat` (§9.1 luật 6) để giữ DAG.
**Nghiệm thu:** scenario không khai báo trong installation → `partial: true` + lý do từng bước, không phải lỗi 500.

### 9.3 Đợt 2 — khép vòng ghi (low_write)

Vẫn qua cổng kép của Chat: `features.actionProposals` + `safety.allowWrites`.

#### T2.1 `crm_post_note`

```
effectClass: low_write · requiresApproval: false · entityScopes: READABLE_ENTITIES
input: { entity, id, text: 1..4000 }
result: { entity, id, streamItemId }
caps: 4 KiB · 10 s
```
Nguồn: `StreamService.create()` — đã có `assertParentAccess`. Đây là hành động AI CRM phổ biến nhất: ghi lại kết quả cuộc gọi.

#### T2.2 `crm_log_activity`

```
effectClass: low_write · requiresApproval: false · entityScopes: [Call, Meeting, Task]
input: { kind: enum("Call","Meeting"),
         name: 1..255, dateStart: ISO, durationMinutes?: 1..1440,
         outcome?: 0..4000, status: "Held" (mặc định),
         related?: { entity: enum(READABLE_ENTITIES), id } }
result: { id, kind, name, dateStart, related }
```
Ghi hoạt động **đã xảy ra**; không gửi thông báo cho khách.

#### T2.3 `crm_draft_email`

```
effectClass: low_write · requiresApproval: false · entityScopes: [Email]
input: { subject: 1..255, body: 1..8000,
         to?: [email] (≤ 5), related?: { entity, id },
         templateId?: string }
result: { id, status: "Draft", subject }
```
Tạo bản ghi `Email` với `status: 'Draft'`. **Không bao giờ gửi** — `queueSend` chỉ nhận status sendable, và tool này không gọi nó. Người dùng mở email và tự gửi.

#### T2.4 `crm_create_task` v2

```
version: "2"
input: { name, description?, dateStart?,
         assignedUserId?,                       // mặc định = actor
         parent?: { entity: enum(READABLE_ENTITIES), id } }
```
Sửa D3: task gắn được bản ghi cha qua `entity_links`.

### 9.4 Đợt 3 — trí tuệ module (read)

Mỗi tool là wrapper mỏng trên service đã có; không nhân bản luật nghiệp vụ.

| key | Nguồn | Trả về | Mở khoá |
|---|---|---|---|
| `crm_lead_score` | `LeadScoreExplanationService.score/history` | điểm, breakdown theo rule, lịch sử | "vì sao lead này nóng" |
| `crm_customer_health` | `CustomerSuccessHealthService.explanation` | điểm sức khoẻ, component, override, renewal | "khách nào sắp rời bỏ" |
| `crm_case_context` | Case + `CaseSLAClock` + `KnowledgeBaseService.suggestForCase` + CSAT | case, đồng hồ SLA, bài viết gợi ý | "soạn trả lời ticket này" |
| `crm_stale_records` | `entity_records` + `stream_items` (NOT EXISTS) | bản ghi không hoạt động ≥ N ngày | data hygiene, next-best-action |
| `crm_run_report` | `ReportService.list/run` (chỉ report người gọi thấy) | kết quả report đã lưu, bounded | trích dẫn báo cáo (PLAN §1.1 mục 5) |

**Ai đăng ký tool nào** (theo §9.1 luật 6):

| Tool | Nơi đăng ký | Vì sao |
|---|---|---|
| `crm_lead_score` | `lead-score` | dùng `LeadScoreExplanationService` |
| `crm_customer_health` | `customer-success` | dùng `CustomerSuccessHealthService` |
| `crm_case_context` | `service-desk` | dùng `KnowledgeBaseService`, đọc `CaseSLAClock` |
| `crm_cross_module` | `crm-chat` | dùng `CRMChatCrossModuleService` |
| `crm_run_report` | `ai-agents` | `reports` là shared core |

Không tool nào trong bảng này được để `ai-agents` import ngược domain.

### 9.5 Nâng cấp tool hiện có

`crm_update_record_fields` v2 — mở `WRITABLE_FIELDS`, **giữ nguyên** `material_write` + approval + kiểm version:

| Entity | Field thêm |
|---|---|
| `Opportunity` | `stage`, `amount`, `closeDate` |
| `Case` | `priority`, `assignedUserId` |
| `Task` | `dateEnd`, `assignedUserId` |
| `Lead` | `assignedUserId` |

Không thêm `delete`, `merge`, hay bất kỳ thao tác không hoàn tác được — chúng thuộc nhóm `high_impact` và cần thiết kế riêng.

### 9.6 Sửa gốc: actor trong system prompt — ✅ đã triển khai

Đặc tả gốc ở đây là "thêm tham số thứ ba cho `systemPrompt`". Bản triển khai đi xa hơn một bước vì lý do test được: `systemPrompt` **được chuyển ra khỏi** `ai-agent-runs.service.ts` (file 2500 dòng) sang module thuần `apps/api/src/ai-agents/ai-agent-actor.ts`, để khối actor test được mà không cần boot API.

| Thành phần | Vai trò |
|---|---|
| `AIAgentActorContext` | `userId`, `displayName`, `userName`, `isAdmin`, `teams[]` |
| `promptSafe(value, max)` | Bỏ ký tự điều khiển, gộp whitespace, cắt độ dài — chặn tên người dùng mở dòng mới trong system message |
| `actorPromptLines(actor)` | Khối `Acting user`, gồm dòng `- id: <id>` có định dạng cố định |
| `systemPrompt(agentName, config, actor?)` | Ghép khối vào giữa operating rules và agent instructions; `actor` vắng → prompt y như cũ |
| `AIAgentRunService.actorContext(userId)` | Hai truy vấn có biên (`users`, `users_teams` ⟕ `teams`), một lần cho mỗi lần thực thi run |
| `FakeProviderAdapter` `__FAKE_ECHO_ACTOR__` | Seam test: trả về **đúng** id trong dòng `- id:`, không trả phần còn lại của prompt |

**Bằng chứng:** `apps/api/test/ai-agent-actor.test.ts` (10 case thuần, có trong `vitest.ci.config.ts`) và một case end-to-end trong `ai-agent-runs.test.ts` chứng minh chuỗi đầy đủ — run do user hạn chế khởi tạo, admin thực thi, model nhận đúng id của **người khởi tạo**, và `crm_search_records` lọc được `assignedUserId` bằng chính id đó.

Đây là thay đổi **rẻ nhất và giá trị cao nhất** trong toàn bộ đề xuất: nó sửa D5 và chip #1 mà không cần tool nào.

### 9.7 Chip gợi ý v2

Chip trở thành **dữ liệu khai báo**, mỗi chip mang `requiresTool`; UI lọc theo `capabilities.assistant.tools` (đã có trong payload, **không cần đổi API**).

| Chip | `requiresTool` |
|---|---|
| Cơ hội đang mở của tôi | — (đã chạy được bằng `crm_search_records` sau §9.6) |
| Pipeline theo giai đoạn quý này | `crm_aggregate` |
| Hôm nay tôi có gì? | `crm_list_activities` |
| Tóm tắt 360° account này | `crm_cross_module` |
| Account nào im lặng 30 ngày? | `crm_stale_records` |
| Vì sao lead này điểm cao? | `crm_lead_score` |
| Soạn nháp follow-up | `crm_draft_email` |
| Ghi lại kết quả cuộc gọi vừa xong | `crm_post_note` |

Không chip nào hiển thị nếu agent chưa được cấp tool tương ứng. Đây là điều kiện để Chat không hứa điều nó không làm được.

### 9.8 Ngoài phạm vi

Xoá/merge bản ghi; gửi email/SMS thật; ghi tài chính (quote, invoice, payment); thay đổi cấu hình marketing; MCP door mở rộng; SQL thô; HTTP tuỳ ý.

---

## 10. Kiểm chứng và nghiệm thu

### 10.1 Ma trận test mỗi tool

| Loại | Nội dung |
|---|---|
| Schema | Field lạ bị từ chối; giá trị ngoài biên → 422 |
| ACL | Người gọi thiếu quyền entity → không thấy dữ liệu, không thấy con số tổng |
| Actor | "mine" chỉ trả bản ghi của người khởi chạy |
| Cap | Kết quả vượt `maxResultBytes` bị cắt và đánh dấu `truncated` |
| Grant | `entityScopes` chưa đăng ký → publish thất bại với thông báo rõ |
| Approval | Tool `material_write` không thể publish mà thiếu `requiresApproval` |

### 10.2 Cổng trước khi merge

`pnpm lint` → `pnpm lint:arch` (DAG không đổi) → `pnpm typecheck` → `pnpm test:ci` (một file mỗi lần chạy) → `pnpm test:web`.

Test thuần mới phải được thêm vào `PURE_API_TESTS` trong `vitest.ci.config.ts` — gate CI **không có database**, nên một file test boot app hoặc chạm Postgres không được nằm ở đó. `ai-agent-actor.test.ts` đã được thêm theo đúng quy tắc này.

### 10.3 Rollback

Tool mới vô hiệu hoá bằng `settings.tools.disabled` (không cần deploy). Chip tự ẩn theo `assistant.tools`. Không có migration nào trong đợt 1–2, nên rollback là cấu hình, không phải dữ liệu.

Riêng §9.6 đã triển khai: rollback là truyền `undefined` cho tham số thứ ba của `systemPrompt` — prompt trở về đúng chuỗi cũ, không có schema, không có dữ liệu nào phải hoàn tác.

---

## 11. Rủi ro

| Rủi ro | Mức | Biện pháp |
|---|---|---|
| Model gọi `crm_aggregate` với `groupBy` trên field cardinality cao | Trung bình | `maxGroups ≤ 10`, cap byte, `truncated` |
| `crm_post_note` bị lạm dụng để ghi nội dung sai lệch | Trung bình | Nội dung do người dùng xác nhận; ghi qua Stream có audit; hiển thị tác giả là agent |
| `crm_draft_email` bị hiểu là "đã gửi" | Cao | Status luôn `Draft`; UI nhãn rõ; không gọi `queueSend` |
| Registry phình làm model chọn sai tool | Trung bình | Thêm theo đợt, mỗi đợt có eval; giữ mô tả tool khác biệt rõ |
| Chu trình phụ thuộc khi domain đăng ký tool | Cao | §9.1 luật 6 + `pnpm lint:arch` |
| Chip gợi ý lệch năng lực agent | Thấp | `requiresTool` + lọc theo `assistant.tools` |
| Tên người dùng/team chứa chỉ thị độc hại trong system message | Trung bình | `promptSafe()` gộp newline + cắt độ dài (§9.6); có case test riêng |
| Model lọc nhầm "của tôi" thành toàn bộ dữ liệu | Thấp | Prompt nói rõ id là để lọc; nếu không lọc được thì phải nói ra, không được trình bày bản ghi người khác như của user |

---

## 12. Lịch sử thay đổi

| Phiên bản | Ngày | Thay đổi |
|---|---|---|
| 1.0.0 | 2026-11-02 | Bản đầu. Chốt đặc tả as-built §1–§7; thêm phân tích khoảng trống §8 và đặc tả AI CRM tool catalogue v2 §9–§11. |
| 1.1.0 | 2026-11-02 | Triển khai §9.6: `ai-agent-actor.ts` (khối "Acting user" + `promptSafe`), `AIAgentRunService.actorContext()`, seam `__FAKE_ECHO_ACTOR__`. Thêm `ai-agent-actor.test.ts` (10 case thuần) và 1 case end-to-end trong `ai-agent-runs.test.ts`. Cập nhật §7.6, §8.1, §8.2. Số entity chính xác: 115. |
| 1.2.0 | 2026-11-02 | Nối SPEC với plan: §9.2–§9.7 giờ trỏ tới phase 19-CHAT.21–24 trong `PLAN_Phase_19_CRM_Chat.md` §17, và dòng trạng thái ở đầu ghi rõ phần nào đã thành phase. Không đổi nội dung kỹ thuật. |
| 1.3.0 | 2026-11-02 | Triển khai 19-CHAT.21. §7.2 lên **12 tool** (thêm `crm_actor_context`, `crm_aggregate`, `crm_list_activities`, `crm_cross_module`) kèm bảng "tool nào trả lời câu gì". §8.1/§8.2/§8.3 cập nhật: D1 và D2 đã sửa, chip "deal quý này" đã sửa, chip hoạt động và email còn lại cho 22/23. §9.2 đánh dấu đã triển khai kèm bảng ba chỗ lệch as-built. |
