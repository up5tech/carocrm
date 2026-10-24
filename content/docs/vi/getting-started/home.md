---
title: Không gian làm việc trang chủ
summary: Trang chủ trả lời những câu hỏi nào, theo thứ tự nào, và mỗi thẻ dẫn tới đâu.
audience: user
order: 25
tags: [home, tasks, calendar, dashboard]
related: [user/dashboards-and-reports, getting-started/find-your-way, user/activities-and-tasks]
updated: 2026-10-24
---

## Trang chủ để làm gì

Trang chủ là màn hình bạn mở đầu tiên, và nó trả lời bốn câu hỏi theo đúng thứ tự này:

1. **Việc gì đang chờ tôi?** — ba thẻ ngay dưới lời chào.
2. **Hôm nay có gì?** — lịch của bạn trong ngày.
3. **Tình hình đang thế nào?** — tối đa ba con số từ bảng điều khiển bạn mặc định mở.
4. **Có gì mới thay đổi?** — các mục mới nhất từ những bản ghi bạn theo dõi.

Đây không phải bảng kiểm kê các loại bản ghi của instance. Không có ô nào cho từng module và không đếm
theo module, nên trang trông giống nhau dù instance bật bốn hay bốn mươi module. Số lượng theo module nằm ở
[bảng điều khiển](user/dashboards-and-reports), [báo cáo](user/dashboards-and-reports) và từng
[màn hình danh sách](user/lists-and-views).

## Dải lời chào

Dòng chữ lớn là lời chào, bên dưới là ngày hôm nay và chức danh của bạn. Tiếp đó là một câu tóm tắt ngày:
bao nhiêu việc đang chờ bạn xử lý, bao nhiêu việc quá hạn và bao nhiêu hoạt động trong hôm nay. Khi không có
gì đang chờ, câu đó nói rõ điều này thay vì hiện một hàng số 0.

Dải này cũng chứa ba việc bạn làm từ đây:

- **Tìm bản ghi** — nhập tên rồi nhấn **Enter** để mở trang kết quả. Gợi ý `⌘K` / `Ctrl+K` bên cạnh mở
  [bảng lệnh](getting-started/find-your-way).
- **Tạo mới** — mở danh sách loại bản ghi giống thanh bên, xếp theo bảng chữ cái. Chọn một loại để mở
  biểu mẫu tạo bản ghi.
- **Bảng điều khiển** — mở màn hình bảng điều khiển, nơi bạn có thể gắn dấu sao cho bảng mặc định.

## Ba thẻ trọng tâm

Mỗi thẻ là một liên kết, và con số của nó nằm trong tên truy cập của thẻ.

| Thẻ | Hiển thị | Mở |
| --- | --- | --- |
| Nhiệm vụ của tôi | Số việc đang chờ, số việc quá hạn và hai hạn gần nhất. | [Nhiệm vụ của tôi](/tasks) |
| Hôm nay | Số hoạt động hôm nay và giờ của hoạt động kế tiếp. | [Lịch](/calendar) |
| Phê duyệt | Số quy trình phê duyệt đang chạy mà bạn tham gia. | [Nhiệm vụ của tôi](/tasks), ở thẻ Phê duyệt |

Nếu một thẻ không tải được, thẻ vẫn giữ nguyên vị trí, báo `Không tải được thẻ này.` và có nút **Thử
lại**. Hai thẻ còn lại vẫn hoạt động: một nguồn lỗi không làm trắng cả trang.

## Lịch hôm nay

Tối đa sáu mục trong ngày của bạn — cuộc gọi, cuộc họp, nhiệm vụ và nhiệm vụ dự án — kèm cột giờ và chấm
màu theo loại. Chọn một mục để mở bản ghi. Nếu trong ngày còn nhiều hơn sáu mục, phần còn lại được đếm
thành `+N hoạt động nữa` và dẫn tới lịch.

Ngày này khớp với màn hình [lịch](user/activities-and-tasks): cả hai dùng cùng bốn loại hoạt động và cùng
một ngày địa phương, nên mục bạn thấy ở đây cũng là mục bạn thấy ở đó.

## Tổng quan

Tối đa ba dashlet KPI từ bảng điều khiển bạn mặc định mở. Bảng điều khiển — và những con số nó hiển thị —
được quyết định trong [Bảng điều khiển](user/dashboards-and-reports): bảng bạn gắn sao, nếu không có thì
bảng theo vai trò của bạn, nếu không có nữa thì bảng đầu tiên bạn thấy. Khi không bảng nào có dashlet KPI,
khối này đơn giản là không xuất hiện; trang chủ không bao giờ quay về đếm theo module.

## Hoạt động

Năm mục mới nhất từ dòng hoạt động bạn theo dõi, kèm người đăng, thời gian tương đối và liên kết tới bản
ghi. Đây chính là [dòng hoạt động](user/activities-and-tasks) lọc theo **Đang theo dõi**. Khi dòng này
trống, hãy theo dõi một bản ghi từ trang của nó hoặc dùng **Tìm bản ghi để theo dõi**.

## Dành cho quản trị viên: dải thiết lập

Khi danh sách kiểm tra lần đầu chưa hoàn tất, quản trị viên còn thấy một dải mỏng dưới lời chào với tiến độ
và hai bước tiếp theo dưới dạng liên kết. Dải này biến mất khi đạt 100 %, và người dùng không phải quản trị
viên không bao giờ thấy nó.

## Đi tiếp

- [Bảng điều khiển và báo cáo](user/dashboards-and-reports) — nguồn của những con số trên trang này.
- [Làm việc với danh sách](user/lists-and-views) — bộ lọc, cột và khung nhìn đã lưu.
