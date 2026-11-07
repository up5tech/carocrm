---
title: CRM Chat và hộp thư thoại
summary: Workspace CRM Chat và panel chat nhanh trên thanh đầu trang, sau đó là hộp thư thoại, nhật ký cuộc gọi và những gì composer làm được và không làm được.
audience: user
order: 130
tags: [chat, crm-chat, voice, calls, sms, assistant]
aliases: ["trò chuyện với trợ lý", "cách dùng chat", "khung nhắn tin", "hộp thư thoại"]
related: [user/stream-and-notifications, user/record-page, admin/settings-overview]
updated: 2026-11-06
---

Có hai bề mặt ở đây và chúng không liên quan đến nhau. [CRM Chat](/crm-chat) là một luồng trò chuyện
giữa bạn và một model trợ lý. [Hộp thư thoại](/voice-inbox) là workspace cho cuộc gọi, SMS, MMS và
WhatsApp — cuộc trò chuyện của con người với khách hàng, không phải với một model.

## Workspace CRM Chat

Mở [CRM Chat](/crm-chat). Trang chỉ trả lời được khi quản trị viên đã chọn một **trợ lý** — một
profile AI Agent đã publish, được chọn theo key — và runtime AI Agent đã bật execution và
conversation memory. Nếu chưa, đầu trang mang một tag trạng thái (`not-configured`, `not-published`,
`execution-disabled`, `memory-disabled`, v.v.) và composer bị vô hiệu; phần còn lại của trang vẫn
dùng được.

Ba khu vực:

- Các cuộc trò chuyện của riêng bạn ở bên trái, hoạt động gần nhất lên đầu. Ô tìm kiếm chỉ xuất hiện khi
  deployment bật `conversationSearch`. Một thread là riêng tư của bạn: điều kiện chủ sở hữu nằm trong
  mọi truy vấn, nên không ai khác — kể cả quản trị viên — nhìn thấy nó trong danh sách của họ.
- Thread đang chọn: tin nhắn gán nhãn theo vai trò, theo thứ tự; một huy hiệu màu cam nếu có nội dung bị
  redact, và một citation chip dưới mỗi câu trả lời. Citation được kiểm tra lại quyền trước khi render,
  nên một nguồn bạn không còn đọc được hiển thị ở trạng thái khoá thay vì mở ra thứ bạn không nên thấy.
  Nút **Load older** phân trang ngược về lịch sử.
- Composer ở dưới cùng. **Templates** chèn một câu đã lưu; **Save as template** lưu bản nháp hiện tại;
  bộ đếm ký tự nằm cạnh nút **Send**.

Danh sách capability, feature flags, thông tin module và health check không nằm trên trang chính:
chúng nằm trong drawer **Diagnostics**, mở từ nút bug trên thanh đầu trang. Chúng trả lời câu hỏi
"sao tôi không gửi được?" — câu hỏi chỉ đặt ra khi có trục trặc, không phải khi đang đọc câu trả lời.

**New** là thao tác phía client. Nó xoá bản nháp và đặt focus vào ô nhập; thread chỉ được tạo phía
server khi tin nhắn đầu tiên được chấp nhận.

Bạn cũng có thể hỏi trợ lý cách *sử dụng* CRM — "bật đăng nhập hai yếu tố ở đâu?", "lên lịch báo cáo
thế nào?" — và nó trả lời từ handbook này, bằng ngôn ngữ của bạn, kèm một chip nguồn đánh số mở đúng
trang nó đã đọc. Nó chỉ chạm tới các trang mà bản thân bạn mở được, và khi handbook không có gì cho câu
hỏi của bạn, nó nói như vậy thay vì đoán.

## Chat nhanh từ thanh đầu trang

Thanh đầu trang có nút **Ask AI** trên mọi màn hình — một panel nhỏ, không phải một workspace thứ hai.
Nó chỉ xuất hiện khi server đưa Chat vào menu của bạn, nên một instance chưa cài đặt module sẽ không
bao giờ hiển thị nó.

Gõ câu hỏi rồi nhấn **Enter**; câu trả lời đến trong panel, gán nhãn theo vai trò, với nút **Stop
generation** trong lúc turn chạy. Hỏi tiếp từ cùng panel tiếp tục cùng cuộc trò chuyện, còn **New
conversation** bắt đầu một cuộc mới. **Open full chat** mở `/crm-chat`, nơi liệt kê các cuộc trò
chuyện của bạn. Panel chỉ hiển thị câu trả lời: không citation, không tệp đính kèm, không xem trước bản
ghi.

Nếu trợ lý muốn thay đổi một bản ghi, turn sẽ hỏi xin quyết định — và quyết định đó được đưa ra trên
trang đầy đủ, nơi có proposal card, không phải trong panel. Panel nói rõ điều đó và dẫn link tới đó.

Cùng panel đó cũng xuất hiện inline nơi câu hỏi vốn đã gắn với một thứ cụ thể:

- Trên thanh đầu của [trang bản ghi](user/record-page), panel mở kèm bản ghi đó làm ngữ cảnh, với các
  gợi ý như tóm tắt bản ghi, nêu bước tiếp theo hay soạn thư follow-up. Hỏi về bản ghi không cần gõ lại tên
  của nó.
- Trên thanh bulk của [màn hình danh sách](user/lists-and-views), panel mở kèm phần đang chọn (bao nhiêu bản
  ghi thuộc loại nào) làm ngữ cảnh, với gợi ý tóm tắt hoặc ưu tiên chúng.
- Trình thiết kế email template có link **Draft with AI** mở workspace chat kèm template làm ngữ cảnh, và
  workspace chat chấp nhận `?ask=` để điền sẵn một lần vào ô soạn.

Inline hay từ thanh đầu trang, panel dùng cùng turn API, cùng ACL và cùng stream: ngữ cảnh chỉ là tiện
ích trong prompt, không phải quyền rộng hơn.

## Composer

Văn bản thuần, tối đa giới hạn hiển thị dưới ô nhập — mặc định 8.000 ký tự. **Enter** gửi,
**Shift + Enter** xuống dòng, **Escape** huỷ turn đang chạy.

Trong lúc turn chạy, composer hiển thị một phase (`queued`, `thinking`, label của tool đang chạy,
`finishing`) và một đồng hồ đếm thời gian, kèm nút **Stop generation**. Phase chỉ là vòng đời; chuỗi
suy luận nội bộ của model không bao giờ được stream.

Hai thứ đi cùng ô nhập:

- **Saved prompts.** Một template là một đoạn văn bản có tên; chọn nó sẽ chèn đoạn văn bản đó như thể bạn
  tự gõ. Nó không phải macro và không phải script — server lưu nó trong một cột text và không bao giờ
  đánh giá/thực thi nó. Quản lý template cần capability `prompts`.
- **Action proposal card.** Nếu trợ lý muốn thay đổi một bản ghi, turn tạm dừng và một card xuất hiện với
  action class, mức rủi ro, một phần xem trước plain-text của đề xuất và thời hạn. **Confirm** và
  **Reject** là hai kết cục duy nhất; cả hai đều gọi server, server kiểm tra lại ACL của bạn, trạng thái
  hiện tại của bản ghi, hash của proposal và thời hạn trước khi bất cứ thứ gì được ghi. Một khi nó hết hạn,
  hoặc người khác đã quyết định, các nút biến mất.

Dưới mỗi câu trả lời của trợ lý có **thumbs up** và **thumbs down** khi deployment bật `feedback` và bạn
có capability `feedback`. Một đánh giá được audit và trơ: nó không thay đổi model, tool hay quyền của
ai, và một phiếu down có thể kèm một ghi chú tuỳ chọn.

Composer không có nút chọn tệp, không dán ảnh và không có đường dẫn đính kèm. Nó cũng không thể chọn
agent, model hay tool, và contract chặn thao tác hàng loạt mang tính phá huỷ, thay đổi ACL hay quyền,
xử lý credential, thanh toán, phát hành hay huỷ hoá đơn, gửi chiến dịch, nhắn tin ra ngoài, cấu hình
provider, đăng ký tool, và SQL thô. Những thứ này bị từ chối phía server, không chỉ bị ẩn đi.

## Hộp thư thoại

[Hộp thư thoại](/voice-inbox) là một màn hình với hai bề mặt, chọn bằng segmented control.

**Inbox** liệt kê các cuộc hội thoại bên trái và thread đã chọn bên phải. Lọc theo trạng thái
(`open`, `pending_customer`, `pending_internal`, `resolved`, `closed`, `spam`), theo kênh (`sms`,
`mms`, `whatsapp`), và theo *Only mine*. Mỗi dòng hiển thị số tin chưa đọc và thời điểm hoạt động cuối.

Một thread hiển thị:

- Bong bóng tin nhắn: đến trong màu xám, đi trong màu xanh, và internal note trong màu vàng với viền
  đứt nét — một note hiển thị rõ ràng không bao giờ là chữ của khách hàng.
- Các dòng sự kiện ở giữa timeline cho thay đổi trạng thái, gán, bỏ gán và link tới case.
- Các control trên header để gán thread cho một người dùng, đổi trạng thái, đánh dấu đã đọc (nút ✓),
  và **Handoff to Case**. Handoff tạo một case Service Desk gắn với thread; nhấn hai lần trên cùng
  thread trả về đúng case đã có thay vì tạo cái thứ hai.
- Một composer: tối đa 4.000 ký tự, một bộ chọn **snippet** với placeholder bạn tự điền (server không
  tự resolve chúng từ dữ liệu CRM), gợi ý segment và encoding theo thời gian thực cho kênh, và một
  switch **Internal note** lưu văn bản thay vì gửi đi. Mỗi lần gửi mang một idempotency key do client
  sinh ra, nên double click hay retry chỉ là một tin nhắn.

**Calls** là nhật ký cuộc gọi — 50 phiên gần nhất, mới nhất lên đầu, mỗi phiên kèm chiều cuộc gọi,
trạng thái, thời lượng và nhóm lý do thất bại. Mở một phiên để xem chi tiết: chiều, số gọi đến và đi,
thời điểm bắt đầu, độ dài, kết quả, và activity CRM được gắn. Hai panel bên dưới:

- **Recordings**, nếu có. Phát lại đi qua API và trả về bytes từ storage riêng tư; trình duyệt không bao
  giờ thấy URL hay token của provider.
- **Transcript**, nếu deployment bật nó. Bạn có thể yêu cầu một bản và làm mới trạng thái. Khi AI
  enrichment bật, **Enrich** thêm một bản nháp tóm tắt, chủ đề, việc cần làm và một câu trả lời gợi ý.
  Bản nháp vẫn chỉ là nháp: **Approve** và **Dismiss** chỉ ghi nhận review của bạn, và không thứ gì model
  tạo ra tự động được gửi đi.

Một banner cuộc gọi đến xuất hiện ở góc mọi màn hình trong khi cuộc gọi đang rung chuông cho bạn. Nó
hiển thị số điện thoại, các bản ghi CRM bạn được phép khớp với người gọi đó, và đúng các control mà tài
khoản provider hỗ trợ — trả lời và cúp máy. Lưu note hoặc gắn cuộc gọi từ banner mà không cần điều
hướng đi đâu.

## Cần bật những gì

> [!WARNING]
> Không có "voice agent" tự hành. Không thứ gì trả lời cuộc gọi thay bạn và không bot nào tự trả lời
> khách hàng. AI ở phía voice là bản nháp enrichment trên transcript, và con người vẫn phải tự gửi tin
> nhắn.

Mọi thứ còn lại trên hai bề mặt này đều nằm sau một công tắc. Với Chat, `features.workspace` bật mặc
định nên shell mở được, nhưng `readTools`, `helpRetrieval`, `actionProposals`, `feedback` và
`conversationSearch` đều bắt đầu ở trạng thái tắt, và một đề xuất chỉ được thực thi khi quản trị viên
cũng đã bật `safety.allowWrites`. Ở phía voice, `voice`, `sms`, `mms`, `whatsapp`, `recordings`,
`transcripts` và `aiEnrichment` đều bắt đầu ở trạng thái tắt, và một cuộc gọi hay tin nhắn phải gọi
tên một tài khoản provider đã cấu hình; bản build này chỉ ships một simulator và một adapter bị vô
hiệu, nên không cuộc gọi thật nào chạm tới điện thoại thật cho đến khi một production adapter được
đăng ký.

## Đi tiếp đâu

- [Tổng quan cài đặt](admin/settings-overview) — các công tắc mà trang này nhắc tới; trang chi tiết về cấu hình CRM Chat (`admin/crm-chat`) hiện có bản tiếng Anh và được hiển thị kèm thông báo fallback.
- [Dòng hoạt động và thông báo](user/stream-and-notifications) — nơi các handoff case và call note rơi xuống.
- [Trang bản ghi](user/record-page) — cách một cuộc gọi hay một case nằm trên bản ghi CRM.
