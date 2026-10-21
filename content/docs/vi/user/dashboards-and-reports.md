---
title: Bảng điều khiển và báo cáo
summary: Những ô bạn mở mỗi sáng, và những câu hỏi đã lưu để chạy khi có người hỏi tình hình thế nào.
audience: user
order: 60
tags: [dashboard, dashlet, report, schedule]
related: [user/lists-and-views, user/import-export]
updated: 2026-10-21
---

Hai màn hình cho hai nhu cầu khác nhau. [Bảng điều khiển](/dashboards) là một bức tường ô số liệu sống để bạn
nhìn. [Báo cáo](/reports) là một câu hỏi bạn đã lưu, chạy khi cần câu trả lời, và xuất khi có người cần con số.

## Bảng điều khiển

Trang chủ của bạn là một bộ đếm cố định, cộng với danh sách kiểm tra thiết lập dành cho quản trị viên. Bất cứ gì
bạn muốn theo dõi cho tử tế thì nên nằm trên một bảng điều khiển.

**Tạo một bảng.** Mở Bảng điều khiển, chọn **Bảng điều khiển mới**, đặt tên cho nó. Bảng điều khiển là của riêng
bạn; một bảng chia sẻ thì đồng nghiệp nhìn thấy được, còn người dùng portal chỉ thấy bảng của chính mình.

**Thêm dashlet.** Các loại đang có hôm nay là:

| Dashlet | Nó hiển thị gì |
| --- | --- |
| Danh sách | Bản ghi của một thực thể, tối đa hai mươi lăm dòng, không có liên kết đi ra. |
| Biểu đồ | Một biểu đồ cột vẽ từ các số đếm đã nhóm. |
| KPI | Một con số duy nhất. |
| Công việc dự án | Phần việc trong một dự án, nhóm theo triage, backlog, work, phase hay sprint. |

Các ô chạy khi bảng điều khiển mở và khi bạn nhấn **Tải lại**; từng ô riêng cũng chạy lại một mình được. Ngôi sao
đánh dấu bảng điều khiển bạn muốn dùng cho lần sau, và lựa chọn đó được lưu trên tài khoản của bạn.

> [!WARNING]
> Một dashlet quét một cửa sổ bản ghi có giới hạn, không phải toàn bộ bảng. Khi buộc phải dừng sớm, chính ô đó sẽ
> nói ra — hãy đọc dòng ấy trước khi trích dẫn con số.

## Báo cáo

**Dựng một báo cáo.** Chọn một thực thể, rồi chọn dạng câu trả lời: danh sách, một con số tổng hợp, bảng nhóm,
biểu đồ, ma trận, hay KPI. Chọn các cột, chiều dòng và chiều cột, mốc thời gian (ngày, tháng, năm) và chỉ số —
đếm, tổng, trung bình, nhỏ nhất hay lớn nhất. Các bộ lọc ghép với nhau bằng **và**, và phần xem trước cho thấy
câu trả lời trước khi bạn lưu bất cứ gì.

**Chạy và xuất.** Một báo cáo đã lưu có thể chạy lại bất cứ lúc nào và xuất ra CSV. Xuất thì cần báo cáo đã được
lưu, và quy tắc cắt bớt cũng áp dụng như vậy: nếu phép quét dừng sớm, bản xuất sẽ cảnh báo bạn.

**Lên lịch.** Một báo cáo có thể được gửi cho chủ sở hữu của nó theo lịch. Mặc định là thứ Hai lúc 08:00; bạn tự
chọn mẫu, và lịch có thể tạm dừng hoặc gỡ bỏ. Chỉ chủ sở hữu hoặc quản trị viên mới đổi được một lịch gửi. Đây là
chỗ duy nhất CRM tự gửi email.

**Giới hạn nên biết:** một báo cáo quét tối đa 2.000 bản ghi, nhóm nhiều nhất 100 giá trị, và một instance chứa
tối đa 200 báo cáo. Phần xem trước hiển thị hai mươi dòng một lần.

## Đọc tiếp ở đâu

- [Nhập và xuất CSV](user/import-export) — khi bạn cần đủ mọi dòng, không phải hình ảnh của chúng.
- [Làm việc với danh sách](user/lists-and-views) — một bộ lọc đã lưu nhẹ hơn một báo cáo.
