---
title: Làm việc với danh sách
summary: Cột, bộ lọc, bộ lọc đã lưu, sắp xếp, sửa nhanh tại ô và những thao tác hàng loạt mà danh sách thực sự có.
audience: user
order: 10
tags: [lists, filters, columns, bulk]
related: [user/record-page, user/import-export]
updated: 2026-10-21
---

Danh sách là màn hình bạn đáp xuống khi mở một loại bản ghi, ví dụ [Liên hệ](/Contact). Mọi thứ trên đó chỉ
xoay quanh một câu hỏi: làm sao đi tới đúng vài dòng bạn quan tâm?

## Tìm bản ghi

- **Ô tìm kiếm** — gõ rồi nhấn **Enter**. Nó khớp tên bản ghi, các trường liên hệ chính (tên, họ, email,
  điện thoại) và khớp id bản ghi một cách chính xác. Đây không phải công cụ tìm toàn văn; muốn vậy xem
  [tìm kiếm](user/search).
- **Bộ lọc** — mở vùng bộ lọc, chọn một trường, một toán tử và một giá trị, rồi nhấn **Áp dụng**. Toán tử
  hiện có là chứa, bằng, khác, lớn hơn, nhỏ hơn, trống và không trống. Nhiều bộ lọc chỉ ghép với nhau bằng
  **và**. **Bỏ chọn** sẽ xóa chúng.
- Trình chọn bộ lọc chỉ đưa ra một danh sách trường ngắn. Nếu trường bạn cần không có ở đó, danh sách vẫn
  hiển thị nó như một cột và trang tìm kiếm vẫn tìm được bản ghi nhờ nó.

## Lưu một bộ lọc

Chọn bộ lọc đã lưu trong trình chọn, hoặc nhấn **Lưu bộ lọc hiện tại** để giữ lại những gì bạn đang có. Bộ
lọc đã lưu thuộc về bạn và là riêng tư. Màn hình này chỉ áp dụng và lưu; đổi tên, sửa hay xóa một bộ lọc thì
bản hiện tại chưa có, nên hãy đặt một cái tên bạn sẽ không phải hối hận.

## Sắp xếp các dòng

- **Sắp xếp** — nhấn vào đầu một cột. Nhấn lần nữa để đảo chiều.
- **Cột** — nút Cột chọn trường nào được hiển thị. Lựa chọn của bạn được nhớ riêng cho từng thực thể.
- **Mật độ và số dòng mỗi trang** — cả hai cũng được nhớ, nên một danh sách bạn đã chỉnh một lần thì vẫn còn
  nguyên như thế.
- Thanh địa chỉ phản chiếu đúng những gì bạn đang xem: bộ lọc, sắp xếp và số dòng đều nằm trong URL, nghĩa là
  trạng thái của một danh sách có thể dán vào trình duyệt của đồng nghiệp và mở ra đúng những dòng đó.

## Sửa một ô mà không mở bản ghi

Với một trường văn bản ngắn hoặc trường số, nhấn vào ô (hoặc đưa tiêu điểm tới đó rồi nhấn **Enter** hay
**Space**), gõ giá trị, rồi nhấn **Enter**. Mỗi lần chỉ lưu một trường. Dropdown, trường quan hệ và ngày giờ
không sửa được theo cách này — hãy mở bản ghi.

## Chọn và cùng thao tác

Tích vào ô bên trái các dòng. Một thanh hiện ra kèm số lượng, **Xóa mục đã chọn** và **Hủy**.

> [!WARNING]
> Xóa hàng loạt là thao tác hàng loạt duy nhất trong bản hiện tại. Không có gán, cập nhật, gộp hay gửi email
> hàng loạt. Sau một lần xóa hàng loạt, một cửa sổ hoàn tác ngắn hiện ra — chỉ vài giây — và các dòng quay lại
> dưới dạng bản ghi *mới* với id mới, nên mọi liên kết tham chiếu id cũ sẽ không quay lại.

## Xuất và nhập

Trên phần đầu trang có **Xuất CSV** và **Nhập CSV** cho thực thể bạn đang xem. Cả hai được trình bày trong
[nhập và xuất CSV](user/import-export).

## Hay gặp gì

| Triệu chứng | Nguyên nhân |
| --- | --- |
| Danh sách báo thực thể không khả dụng | Metadata của thực thể đó tải không thành công. Hãy tải lại; nếu vẫn bị, nhờ quản trị viên. |
| Thiếu một dòng bạn chờ thấy | Bạn không có quyền với bản ghi đó, hoặc vẫn còn một bộ lọc đang áp. Kiểm tra lại URL. |
| Bản xuất có nhiều dòng hơn những gì bạn thấy | Xuất chỉ theo bộ lọc — không theo thứ tự sắp xếp hay trang bạn đang xem. |

## Đọc tiếp ở đâu

- [Xem và sửa một bản ghi](user/record-page) — màn hình bản ghi gồm những gì.
- [Bảng điều khiển và báo cáo](user/dashboards-and-reports) — danh sách bạn cứ quay lại thì nên nằm trên bảng điều khiển.
