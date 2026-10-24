---
title: Thực thể, trường và bố cục
summary: Thêm một kiểu bản ghi, thêm một trường, và sắp xếp lại các nhóm — không cần sửa code hay triển khai.
audience: admin
order: 60
tags: [entity, field, layout, metadata]
related: [admin/settings-overview, admin/main-menu]
updated: 2026-10-24
---

CRM này chạy bằng metadata: một kiểu bản ghi là gì, nó có những trường nào, các màn hình của nó được sắp ra
sao. Tất cả đều sửa được lúc đang chạy từ [Quản lý thực thể](/admin/entity-manager), và mỗi thay đổi áp lên
instance đang chạy ngay khi bạn lưu.

> [!NOTE]
> Metadata mô tả các màn hình và API. Nó không dời cột trong database, và chỉ mục bạn thêm ở đây là một khai
> báo, không phải một migration. Bất cứ gì thay đổi schema vật lý đều là việc của bước triển khai.

## Tạo một kiểu bản ghi

Chọn **Tạo** và đặt cho nó một tên theo PascalCase, kiểu `Warranty`, cùng một nhãn. Một thực thể mới đến kèm
bộ trường ghi chép mà mọi bản ghi đều có — id, tên, mô tả, mốc tạo và sửa, người tạo và người sửa, người dùng
được gán, các nhóm, và một cờ xóa mềm — cộng thêm một trường text ngắn dành cho mã.

Sau đó quyết định nó cư xử thế nào:

| Cấu hình | Nằm ở |
| --- | --- |
| Nhãn và biểu tượng | Chính thẻ của thực thể |
| Bật hay tắt | Biến kiểu bản ghi thành thứ mà giao diện bỏ qua |
| Điều hướng | Nhóm của nó trên thanh bên, thứ tự của nó, có bị ẩn hay không, và màn hình board nhóm theo trường nào |
| Quan hệ | Nó trỏ tới những kiểu nào, và các dòng đó mang nhãn gì |
| Logic động | Những quy tắc ẩn, bắt buộc hoặc đặt giá trị trường tùy theo những gì đang được nhập |

Một thực thể bị tắt không bị xóa: bản ghi của nó vẫn nằm trong database, chỉ giao diện ngừng liệt kê nó.

## Trường

Thêm một trường từ danh sách trường của thực thể. Những kiểu bạn chọn được hôm nay:

```text
varchar  text  int  float  decimal  bool  date  datetime
enum  multiEnum  currency  url  email  phone  link  linkMultiple  formula
```

Hai giới hạn sau quan trọng hơn cả danh sách:

- **Kiểu của một trường không đổi được sau khi nó đã tạo.** Hãy chọn có chủ ý, hoặc thêm trường mới rồi tắt
  trường cũ.
- **Gỡ một trường là tắt nó, không phải xóa nó.** Giá trị vẫn còn, và trường ngừng xuất hiện trên màn hình
  cũng như trong tệp xuất. Một trường không thể đổi tên theo cách lấy lại tên cũ cho thứ khác.

Đổi *nhãn* của một trường thì lúc nào cũng an toàn — đó là chữ, không phải dữ liệu.

## Bố cục

Bố cục quyết định thứ tự của những gì một người đọc. Trình chỉnh sửa phủ năm màn hình:

| Màn hình | Nó điều khiển gì |
| --- | --- |
| Danh sách | Trường nào trở thành cột. Trường bị bỏ ngoài thì không thành cột; nó vẫn có trên bản ghi. |
| Chi tiết | Các nhóm trường trên màn hình bản ghi, và các trường trong từng nhóm. |
| Chỉnh sửa | Cùng cấu trúc đó cho biểu mẫu tạo và sửa. |
| Panel liên kết | Các cột phụ hiện trong danh sách quan hệ trên trang bản ghi, sau tên bản ghi. |
| Popup liên kết | Các cột phụ hiện trong popup chọn bản ghi có sẵn, sau tên bản ghi. |

Hai màn hình sau là một danh sách trường có thứ tự thay vì các nhóm có tên; tên bản ghi luôn là cột đầu
tiên, chỉ các trường bạn thêm vào mới hiện tiếp theo.

Kéo một trường giữa một nhóm và khu trường còn lại, đổi tên hay gỡ một nhóm, sắp lại thứ tự — và khung xem
trước bên phải hiện kết quả trước khi bạn lưu. Những trường không rơi vào nhóm nào sẽ được gom dưới mục
**Khác** ở cuối bản ghi, nên không có gì trở thành không với tới được. Khi một bản ghi có từ hai quan hệ trở
lên, màn hình chi tiết có thể xếp chúng thành tab thay vì chồng các nhóm lên nhau.

> [!NOTE]
> Bố cục của bộ lọc, tìm kiếm và cập nhật hàng loạt có tồn tại trong metadata nhưng không có trình chỉnh sửa
> trên màn hình này. Ở đây chúng chỉ đọc.

## Có thể gặp sự cố gì

| Dấu hiệu | Nguyên nhân |
| --- | --- |
| Lưu bố cục bị từ chối kèm lỗi trường | Một nhóm khai tên một trường không tồn tại, hoặc trường bạn đã tắt. |
| Một trường mới không xuất hiện | Nó không nằm trong bố cục. Kéo nó vào một nhóm, hoặc chấp nhận để nó dưới **Khác**. |
| Thay đổi biến mất sau khi tải lại | Hai quản trị viên cùng sửa một thực thể. Tải lại và áp dụng lại. |
| Thanh bên không có thêm kiểu bản ghi mới | Cấu hình Điều hướng của thực thể, rồi đến [menu chính](admin/main-menu). |

Mỗi lần ghi metadata đều được ghi vào [Nhật ký kiểm toán](/admin/audit-log), nên bạn thấy ai đã sửa trường nào.

## Đọc tiếp ở đâu

- [Nhập và xuất CSV](user/import-export) — những kiểu trường nào nhận dữ liệu vào.
- [Khu quản trị](admin/settings-overview) — các màn hình quản trị còn lại được sắp xếp thế nào.
