---
title: Trợ lý AI (AI Agents)
summary: Một run ghi lại những gì, conversation memory hoạt động thế nào, khi nào agent phải hỏi con người, và phần usage không cho bạn biết điều gì.
audience: user
order: 140
tags: [ai-agents, agents, runs, approvals, usage]
aliases: ["trợ lý AI", "tác nhân AI", "chạy trợ lý", "hỏi AI về dữ liệu"]
related: [user/record-page, admin/settings-overview, admin/users-teams-roles]
updated: 2026-11-05
---

Module AI Agents là một trang duy nhất với các tab, mở từ sidebar hoặc bằng [Mở màn hình AI agents](/ai-agents).
Một tab chỉ xuất hiện khi role của bạn có quyền mà nó cần; server thực thi từng request, nên một tab bị ẩn
chỉ là định hướng, không phải ổ khoá.

## Overview và Agents

**Overview** là chẩn đoán: sức khoẻ module, các provider và adapter, version của settings, các feature
switch, các check của module và quyền của riêng bạn. Nó mô tả deployment, không phải hoạt động của bạn.

**Agents** liệt kê các định nghĩa bạn được phép thấy: tên và key, trạng thái, version kèm tag
"Unpublished changes", số tool, visibility và lần cập nhật cuối. Tìm kiếm và bộ lọc trạng thái thu hẹp
danh sách. Mở một dòng để xem cấu hình, các version và báo cáo validation của nó. **Run** chỉ xuất hiện
trên một agent đã publish mà bạn được phép chạy, và bị từ chối trong khi execution chưa khả dụng.
Các lệnh nháp, publish và lifecycle là những quyền riêng biệt.

## Bắt đầu một cuộc hội thoại

1. Mở tab **Agents** và bấm vào một agent có trạng thái **published**.
2. Bấm **Run**.
3. Mô tả nhiệm vụ, tối đa 4.000 ký tự.
4. Nếu agent dùng conversation memory, chọn một thread trước đó hoặc để trống ô đó để tạo thread mới.
5. Bấm **Start run**. Tab **Runs** mở ra tại run mới.

Một run là một lần thực thi một nhiệm vụ bởi đúng một version agent đã capture, không phải một tin nhắn
trong chat. Agent chỉ có thể dùng tool từ một catalogue cố định: search, read, list related và tóm tắt bản
ghi, tạo một task nội bộ, và đề xuất một cập nhật trường. Tool chạy dưới quyền truy cập của bạn, và việc
cập nhật trường luôn chờ một con người quyết định.

> [!NOTE]
> Execution mặc định tắt. Nếu đầu trang báo execution đang tắt hoặc bị tạm dừng, không run mới nào có thể
> bắt đầu; quản trị viên thay đổi điều đó trong **Settings**. Các run và conversation hiện có vẫn đọc
> được.

## Runs và Conversations

### Runs

Một run ghi lại tên agent và version đã capture, trigger, văn bản nhiệm vụ, các timestamp, số bước, số
lần gọi tool và gọi model, số token, kết quả hoặc thông báo lỗi, từng lần gọi tool và một timeline chỉ
được thêm vào. Các trạng thái là queued, running, waiting for approval, waiting for input, retry wait,
cancel requested, succeeded, partly succeeded, failed, canceled, expired, blocked by policy và unknown
outcome. Trạng thái kết thúc không bao giờ thay đổi nữa.

Tiến trình trực tiếp là polling, không phải streaming: khi danh sách hoặc run đang mở còn active, trang
refresh mỗi bốn giây và dừng lại ở trạng thái kết thúc. Timeline là danh sách sự kiện của server, không
phải suy luận từ các bộ đếm. **Cancel run** dừng bước hiện tại và giữ nguyên các effect đã ghi nhận.
**Retry** bắt đầu một run mới và chỉ được gợi ý cho các run failed, canceled, expired hoặc blocked; một
unknown outcome không retry được.

Danh sách bắt đầu ở **My runs**; **All runs** cần quyền audit, và run của người khác thì không tìm thấy.

### Conversations

Tab **Conversations** tồn tại khi module memory bật và bạn có quyền sử dụng. Nó hiển thị các thread bạn
sở hữu: tiêu đề, agent, trạng thái, số tin nhắn, hoạt động cuối và hạn hết hạn. Mở một thread để đọc các
lượt của nó và bản rolling summary do hệ thống sinh ra.

- **Archive** ngăn thread nhận thêm turn mới.
- **Delete** xoá thread và toàn bộ tin nhắn của nó, vĩnh viễn.
- **Stored memory** liệt kê summary và các memory item được curated, mỗi item có nút delete riêng.

Chỉ bạn mới đọc được thread của mình, chúng hết hạn theo cửa retention, và một tham chiếu memory được
kiểm tra lại với quyền của bạn trước khi tái sử dụng. Quản trị viên policy thấy một card **Retention**
cho phép xem trước lần sweep.

## Approvals

Một agent tạm dừng khi nó đề xuất một lần gọi tool có effect class nằm trong approval policy — mặc định
là material và high-impact writes — hoặc một tool luôn cần approval, chẳng hạn tool cập nhật trường. Run
chờ ở trạng thái **waiting for approval** cho đến khi reviewer quyết định hoặc đề xuất hết hạn
(mặc định 60 phút).

Tab **Approvals** cần quyền approval và liệt kê mọi đề xuất đang chờ, không chỉ của các run của bạn. Mở
một đề xuất để xem summary, agent và version, mức rủi ro, tool, các bản ghi mục tiêu, giá trị trước và
sau, các argument và thời hạn.

- **Approve** ghi lại tên bạn và ghi chú tuỳ chọn, kiểm tra lại tool, grant, argument, target và policy,
  rồi xếp run vào hàng đợi lại. Nếu bất cứ thứ gì đã thay đổi, approval bị vô hiệu và run kết thúc ở
  trạng thái blocked by policy thay vì thực thi.
- **Reject** huỷ run, vô hiệu các approval đang chờ khác của nó và ghi lại ghi chú của bạn.
- Một đề xuất quá hạn sẽ đóng với trạng thái expired và run của nó kết thúc là expired; việc mở hộp thư
  thực hiện lần sweep đó và báo cáo số lượng.

> [!WARNING]
> Một approval bao phủ đúng một đề xuất với các dữ kiện tại thời điểm bạn quyết định. Self-approval được
> phép: nếu bạn duyệt một đề xuất do chính bạn khởi tạo, nó được ghi lại và gắn tag "Self-approved",
> không bị từ chối.

## Evaluations và usage

### Evaluations

Tab **Evaluations** hiển thị cho role có quyền evaluation. Nó liệt kê các suite với key, yêu cầu khi
publish và trạng thái bật; người có quyền evaluation có thể tạo suite **Publication gate** chuẩn. Chọn
một agent và suite, bấm **Run**, và run hiển thị checksum của draft cùng kết cục của từng case.

Các deterministic case kiểm tra draft offline: cấu hình và giới hạn, tool grants, approval coverage,
budgets, provider allowlist, memory policy và ownership. Suite không gọi model để chấm câu trả lời.
Một model-review case chỉ mang tính advisory và không bao giờ tự chạy; một human-review case chờ cho
đến khi một con người quyết định. Tab này ghi nhận quyết định đó: một human-review row đang pending
hiển thị nút **Approve** và **Reject** cho người có quyền evaluation, và suite chỉ đạt "passed" sau khi
có một approval.

Cổng (gate) là thật: khi evaluations và một required suite được bật, việc publish một draft chính xác
cần một run pass của suite đó tại cùng checksum.

### Usage

Tab **Usage** cần quyền usage. Các tổng của nó — runs, model calls, tool calls và tokens — bao phủ
toàn instance, không chỉ các run của bạn, và được chia theo agent và theo provider và model.

Con số chi phí được gán nhãn. Nó là một ước lượng từ bảng giá per million tokens của quản trị viên,
hoặc "no price data" khi không khớp; không bao giờ là số tiền provider đã tính. Khi không có bảng giá,
tổng là zero vì không có gì được định giá, không phải vì các run miễn phí.

Budgets hiển thị **OK**, **Near limit** hoặc **Exhausted**. Ngưỡng phần trăm cảnh báo chỉ là cảnh báo;
một hard limit từ chối công việc mới. Thay đổi pricing và quota cần policy administration. Usage là một
sổ cái bộ đếm, không phải hoá đơn và không phải phân chia theo từng người.

## Providers và Settings

**Providers** và **Settings** là các bề mặt quản trị nằm trong trang này. Providers quản lý kết nối
model, các model trong allowlist, credential chỉ-ghi và một connection check. Settings giữ features,
các trần giới hạn, approval classes và lifetime, retention, data policy, default connection, disabled
tools và nút dừng khẩn cấp. Đây là phía module của [Tổng quan cài đặt](admin/settings-overview); trang
chi tiết về cấu hình AI Agents (`admin/ai-agents`) hiện có bản tiếng Anh và được hiển thị kèm thông báo
fallback.

Nếu một trong hai tab vắng mặt, role của bạn thiếu quyền đó và không gì ở đây thay đổi được điều đó;
hãy hỏi quản trị viên cấp quyền trên [Người dùng, nhóm và phân quyền](admin/users-teams-roles). Sử dụng
thông thường chỉ cần quyền dùng agents; review approvals, đọc usage và quản lý evaluations là các quyền
riêng biệt.

## Khi có trục trặc

| Symptom | Ý nghĩa | Việc cần làm |
| --- | --- | --- |
| Execution tắt hoặc bị tạm dừng ở đầu trang | Feature bị vô hiệu, hoặc kill switch của operator đang bật; lịch sử vẫn đọc được | Quản trị viên bật nó hoặc gỡ tạm dừng trong Settings |
| Agent đã publish không có nút Run | Bạn thiếu quyền use, hoặc agent không còn published | Kiểm tra trạng thái của nó; xin quyền |
| Một run chờ ở waiting for approval | Đề xuất cần reviewer và hết hạn nếu không ai quyết định | Mở Approvals với quyền approval |
| Approve bị từ chối vì không còn thực thi được | Tool, grant, target hoặc policy đã thay đổi sau đề xuất | Bắt đầu run mới; approval đã bị vô hiệu |
| Một run vắng mặt trong Runs | Danh sách chỉ hiển thị run của bạn nếu không có quyền audit | Dùng My runs hoặc xin quyền audit |
| Không có tab Conversations | Module memory tắt, hoặc bạn thiếu quyền use | Memory phải bật và agent phải được cấu hình cho nó |
| Không có tab Approvals, Usage hay Evaluations | Mỗi tab là một quyền riêng | Xin đúng quyền bạn cần |
| Chi phí là zero và gắn nhãn no price data | Chưa có provider request nào được định giá; có thể thiếu price card | Quản trị viên policy thêm price card |
| Publish báo suite chưa pass cho draft này | Gate không có run pass nào tại checksum của draft này | Chạy required suite; một human-review case cần một lần Approve trong tab Evaluations |

## Đi tiếp đâu

- [Tổng quan cài đặt](admin/settings-overview) — cách các màn hình quản trị được tổ chức và cách lưu hoạt động.
- [Người dùng, nhóm và phân quyền](admin/users-teams-roles) — ai nhận các quyền use, review, usage và admin.
- [Đọc và sửa một bản ghi](user/record-page) — các bản ghi và trường mà một tool có thể chạm tới.

Trang chi tiết cho quản trị viên về providers, execution, approvals và budgets (`admin/ai-agents`) hiện
có bản tiếng Anh và được hiển thị kèm thông báo fallback.
