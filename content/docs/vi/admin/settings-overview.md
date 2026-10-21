---
title: Khu quản trị
summary: Các màn hình quản trị được tổ chức thế nào, ai được mở từng màn hình, và việc lưu một cấu hình diễn ra ra sao.
audience: admin
order: 10
tags: [admin, settings, permissions]
related: [admin/main-menu, admin/users-teams-roles]
updated: 2026-10-21
---

Mở [Quản trị](/admin/settings) từ thanh bên hoặc bảng lệnh. Khung màn hình là một cột tab bên trái và một
trình chỉnh sửa bên phải.

## Các tab

Bạn thấy gì trong cột đó phụ thuộc vào chính bạn. Danh mục tab do sản phẩm cố định và chia nhóm: Hệ thống,
Người dùng, Bảo mật, Tùy biến, Truyền thông, Module và tích hợp; một nhóm không còn tab nào sẽ không được
hiện. Danh sách của bạn sau đó lọc theo cấp, và tab đầu tiên bạn mở được sẽ thành tab mở đầu — đó là lý do
hai quản trị viên có thể vào hai màn hình khác nhau từ cùng một URL.

| Tab | Nằm ở |
| --- | --- |
| Chung, Ngôn ngữ và thời gian, Menu chính, Bố cục | `/admin/settings/general`, `/localization`, `/menu`, `/layout` |
| Quản lý thực thể, Tệp đính kèm, Tác vụ, Nhật ký kiểm toán | `/admin/entity-manager`, `/admin/settings/attachments`, `/admin/jobs`, `/admin/audit-log` |
| Người dùng, Nhóm, Phân quyền, Cổng thông tin | `/admin/settings/users`, `/teams`, `/roles`, `/admin/portals` |
| Xác thực, Tổng quan quyền, API key, Hệ thống | `/admin/settings/authentication`, `/permissions`, `/apiKeys`, `/internal` |
| Email, Thông báo, Webhook | `/admin/settings/email`, `/notifications`, `/webhooks` |
| Bán hàng, Bàn trợ giúp, Thành công của khách hàng, Marketing, CRM Chat, Thoại & Liên lạc, Tiện ích mở rộng, Luồng công việc, Quy trình | Trang riêng của từng module, vào từ chính cột này |

Ba hệ quả mà mọi người hay bất ngờ:

- Quản trị viên và quản trị viên hệ thống là **cùng một cấp** trong bản cài đặt này. Không có tài khoản super
  riêng, nên "system administrator" trong giao diện chỉ là nhãn trên một tab, không phải quyền lực cao hơn.
- Tab bạn không được mở sẽ vắng mặt khỏi cột. Cố mở URL của nó cũng chỉ cho bạn một cột trống và thông báo
  "Bạn không có quyền mở phần này" — dữ liệu phía sau vẫn bị server từ chối.
- Tab module chỉ xuất hiện khi module đó đã cài, nên một instance mới tinh có cột tab ngắn hơn.

## Cách lưu hoạt động

Màn hình cấu hình được dựng trên một **tài liệu**: cả tab là một tài liệu JSON mà bạn chỉnh và công bố như
một khối. Những tab đó có thanh lưu với **Lưu**, **Bỏ thay đổi** và **Tải lại**, và tab trong cột có một dấu
chấm khi bản nháp khác bản đã lưu. Màn hình bản ghi — người dùng, nhóm, phân quyền, API key, quyền, email,
công cụ nội bộ — lưu ngay từng thay đổi và không có thanh lưu.

| Đã xảy ra gì | Nghĩa là gì |
| --- | --- |
| Có lỗi trường ngay dưới ô nhập, và chưa lưu gì | Tài liệu không qua được bước kiểm tra. Sửa đi; bản đã lưu vẫn nguyên. |
| "Reload the tab before saving" | Người khác lưu trước bạn. Hãy Tải lại, áp dụng lại thay đổi, rồi công bố. |
| Tab hiện toàn giá trị mặc định bạn chưa từng đặt | Dòng đã lưu không đọc được thành tài liệu này. Service đã quay về giá trị mặc định thay vì báo lỗi — hãy xem Nhật ký kiểm toán. |

> [!WARNING]
> Rời một tab quản trị khi còn thay đổi chưa lưu chỉ được cảnh báo lúc trình duyệt tải lại hoặc đóng.
> Bấm sang tab khác trong cột thì có chặn; tự gõ một địa chỉ mới thì không.

## Có thể gặp sự cố gì

| Dấu hiệu | Cần xem ở đâu |
| --- | --- |
| Một cấu hình lưu xong mà chẳng gì thay đổi | Màn hình đọc cấu hình đó có cache. Tác vụ và dữ liệu kiểu tác vụ tự làm mới; hãy đọc ghi chú ngay trên tab đó. |
| Thanh bên không theo một thay đổi menu | [Menu chính](admin/main-menu) — cache điều hướng bị xóa khi lưu. |
| Người dùng không thấy một màn hình mà bạn thấy | [Người dùng, nhóm và phân quyền](admin/users-teams-roles). Ẩn một điều khiển trong giao diện không phải là phân quyền; server mới là nơi quyết định. |

## Đọc tiếp ở đâu

- [Menu chính](admin/main-menu) — thanh bên hiện gì cho những người còn lại.
- [Thực thể, trường và bố cục](admin/entities-and-fields) — khi một màn hình thiếu trường bạn cần.
- [Nhật ký kiểm toán](/admin/audit-log) và [tác vụ](/admin/jobs) — đọc gì khi có chuyện không ổn.
