---
title: Nhập và xuất CSV
summary: Vòng đi-về CSV trên màn hình danh sách — tệp phải trông ra sao và một lần nhập chính xác thì làm gì.
audience: user
order: 70
tags: [csv, import, export, data]
related: [user/lists-and-views, admin/entities-and-fields]
updated: 2026-10-21
---

Cả hai nút đều nằm trên [màn hình danh sách](user/lists-and-views) của thực thể bạn đang làm việc, nên một lần
nhập hay một lần xuất luôn thuộc về đúng một loại bản ghi.

## Xuất

Nhấn **Xuất CSV**. Tệp được dựng từ những bản ghi mà bộ lọc hiện tại khớp — toàn bộ tập khớp, không phải trang
bạn đang xem, và cũng không theo thứ tự sắp xếp của bạn. Những gì bạn nhận được:

- mỗi bản ghi một dòng, mỗi trường một cột, trừ trường mật khẩu và các cột sổ sách (`id`, `createdAt`,
  `modifiedAt`, `createdById`, `modifiedById`, `deletedAt`),
- tối đa 10.000 dòng,
- ký tự kết thúc dòng kiểu Windows và một tên tệp dạng `Contact-2026-10-21.csv`,
- một dấu nháy đơn đứng đầu mọi ô bắt đầu bằng `=`, `+`, `-`, `@` hoặc tab, để bảng tính không thể thực thi ô đó.

Dòng tiêu đề của tệp xuất dùng tên trường, không dùng nhãn hiển thị — `emailAddress`, chứ không phải "Email".

## Nhập

Nhấn **Nhập CSV**, dán nội dung tệp vào ô, rồi xác nhận.

> [!NOTE]
> Không có trình chọn tệp, không có bước ánh xạ cột và không có chạy thử. Bạn dán gì thì hệ thống chạy cái đó, nên
> hãy thử trước với hai ba dòng.

Tệp phải phân tách bằng dấu phẩy, với tên trường nằm ở dòng không rỗng đầu tiên. Ô có dấu bao quanh được hỗ trợ,
nên một giá trị chứa dấu phẩy hoặc xuống dòng vẫn qua được trọn vòng đi-về.

Mỗi dòng sẽ ra sao:

| Tệp của bạn | Kết quả |
| --- | --- |
| Một cột không có trường nào tên như vậy | Toàn bộ lần nhập dừng lại. Hãy sửa dòng tiêu đề. |
| Không có cột `id` | Mọi dòng đều được **tạo mới**. Dán cùng một tệp hai lần sẽ tạo bản trùng. |
| Có cột `id` | Bản ghi đó được **cập nhật**; một id không còn tồn tại sẽ tạo bản ghi mới thay vì báo lỗi. |
| Trường đúng/sai | `true`, `1`, `yes` hay `y` đều được chấp nhận, phía phủ định cũng vậy. |
| Trường chọn nhiều giá trị | Tách theo dấu phẩy, dấu chấm phẩy hoặc dấu gạch đứng. |
| Ngày hoặc ngày giờ | Viết theo dạng lịch thông thường; giá trị được lưu dưới dạng một thời điểm. |
| Trường quan hệ, dropdown hoặc địa chỉ | Không nhập được qua màn hình này. |

Lần chạy diễn ra đồng bộ và báo cáo những gì nó đã làm: tạo mới, cập nhật, bỏ qua, kèm số dòng của mọi dòng nó từ
chối. Nó bỏ cuộc sau 50 lỗi. Trần cho mỗi lần nhập là 5 MiB và 2.000 dòng.

## Một vòng đi-về an toàn

1. Xuất một vài dòng và mở tệp bằng một trình soạn thảo văn bản thuần.
2. Sửa những giá trị bạn cần, giữ nguyên dòng tiêu đề, giữ cột `id`.
3. Dán ba dòng đầu rồi nhập. Kiểm tra bản ghi trên màn hình.
4. Nhập phần còn lại.

## Đọc tiếp ở đâu

- [Thực thể, trường và bố cục](admin/entities-and-fields) — vì sao một trường có thể từ chối cho nhập.
- [Bảng điều khiển và báo cáo](user/dashboards-and-reports) — lập báo cáo trên dữ liệu thay vì dán nó vào.
