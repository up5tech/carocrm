---
title: Thương hiệu, ngôn ngữ và thời gian
summary: Tên và biểu trưng ở góc màn hình, những ngôn ngữ mọi người được chọn, và múi giờ instance đang chạy.
audience: admin
order: 20
tags: [brand, localization, locale, timezone]
related: [admin/settings-overview, admin/main-menu]
updated: 2026-10-21
---

Hai tab, đều nằm trong [Quản trị](/admin/settings): **Chung** cho tên gọi của sản phẩm, và **Ngôn ngữ và
thời gian** cho những ngôn ngữ được dùng và chiếc đồng hồ nó chạy theo.

## Chung

Tài liệu thương hiệu có ba trường và không có gì thêm:

| Trường | Giới hạn | Thay đổi gì |
| --- | --- | --- |
| Tiêu đề trang | 80 ký tự | Tên trên đầu thanh bên và tiêu đề tab trình duyệt. |
| Chữ chân trang | 200 ký tự | Dòng dưới biểu mẫu đăng nhập và phần cuối khung ứng dụng. |
| Logo | một tệp đính kèm dạng ảnh | Biểu trưng trên đầu trang. Phải là ảnh bạn đã tải lên dưới dạng tệp đính kèm. |

> [!NOTE]
> Không có cài đặt màu sắc, theme hay chế độ tối. Giao diện dùng đúng một theme, và phần thương hiệu đổi chữ
> cùng biểu trưng, không đổi bảng màu.

**Mở màn hình này:** [Cài đặt Chung](/admin/settings/general).

## Ngôn ngữ và thời gian

Tài liệu ngôn ngữ và thời gian quyết định ba việc:

- **Ngôn ngữ bật** — những ngôn ngữ bất kỳ ai cũng có thể chọn, từ một tới hai mươi. Ngôn ngữ không bật ở đây
  sẽ không xuất hiện trong menu ngôn ngữ của người dùng.
- **Ngôn ngữ mặc định** — cái mà khách mới truy cập thấy, và chỗ dựa khi một bản dịch còn thiếu. Phải là một
  trong những ngôn ngữ đã bật.
- **Múi giờ mặc định** — múi giờ áp cho người dùng chưa tự chọn múi riêng.

Mỗi quy tắc được kiểm vào lúc bạn công bố: ngôn ngữ không có bảng dịch trên đĩa sẽ bị từ chối, ngôn ngữ mặc
định chưa bật cũng bị từ chối, còn múi giờ được kiểm theo quy tắc lịch của chính nền tảng.

Không có cài đặt tuần bắt đầu hay ngày đầu tuần. Một tháng trên lịch bắt đầu đúng nơi nền tảng bắt đầu.

**Mở màn hình này:** [Cài đặt Ngôn ngữ và thời gian](/admin/settings/localization).

## Ai quyết định một người thấy ngôn ngữ nào

Ba lớp, theo thứ tự ưu tiên:

1. Chính người dùng chọn trên [trang hồ sơ](getting-started/your-profile) của họ, hoặc trong menu avatar, vì
   cả hai ghi cùng một cài đặt.
2. Ngôn ngữ mặc định của instance, dành cho người chưa từng chọn.
3. Ngôn ngữ của trình duyệt, tức thứ mà khách đã đăng xuất thấy trên màn hình đăng nhập.

Múi giờ đặt trên hồ sơ chỉ thay đổi cách người đó đọc mốc thời gian. Nó không bao giờ thay đổi một thời điểm
đã lưu, nên không dịch chuyển hạn chót của bất kỳ ai khác.

## Có thể gặp sự cố gì

| Dấu hiệu | Nguyên nhân |
| --- | --- |
| Một ngôn ngữ vắng mặt khỏi menu | Nó không nằm trong danh sách bật. Thêm vào rồi công bố. |
| Công bố báo ngôn ngữ không xác định | Bảng dịch của ngôn ngữ đó chưa được cài trên instance này. |
| Ngày giờ sai với đúng một người | Múi giờ trên hồ sơ của người đó. Hãy chỉ họ về hồ sơ. |
| Tên mới của bạn không hiện ra | Trình duyệt đã cache trang. Tải lại; logo được lấy qua endpoint riêng của nó. |

## Đọc tiếp ở đâu

- [Menu chính](admin/main-menu) — đổi tên những gì mọi người thấy trên thanh bên.
- [Khu quản trị](admin/settings-overview) — một tài liệu lưu thế nào, và vì sao một tab là một lần lưu.
