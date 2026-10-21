---
title: Menu chính
summary: Bật, đổi tên, sắp lại và tô màu thanh bên mà mọi người dùng thấy — và những gì các điều khiển này không làm được.
audience: admin
order: 30
tags: [menu, navigation, sidebar]
related: [admin/settings-overview, admin/branding-and-localization]
updated: 2026-10-21
---

**Mở màn hình này:** [Cài đặt Menu chính](/admin/settings/menu).

Menu là một tài liệu. Những gì bạn chỉnh vẫn là bản nháp cho tới khi bạn công bố tab, và chỉ các mục bạn thực
sự thay đổi mới được lưu — mọi thứ khác tiếp tục chạy theo đúng những gì sản phẩm phát hành, nên một bản nâng
cấp vẫn cải thiện được hàng bạn chưa từng chạm vào.

## Bạn làm được gì với một mục

| Điều khiển | Tác dụng |
| --- | --- |
| Bật / tắt | Mục bị tắt sẽ bị bỏ khỏi thanh bên của mọi người. Các dòng đã tắt được liệt kê ở cuối để bạn bật lại. |
| Đổi tên | Bạn chọn một nhãn, trong số những nhãn sản phẩm đã biết. Một từ mới mà chưa ai dịch thì màn hình này không tự bày ra được. |
| Biểu tượng | Từ một bộ biểu tượng cố định. |
| Màu nhấn | Từ một bảng màu cố định, nên một mục được tô màu vẫn khớp giao diện. |
| Đổi thứ tự | Các nút lên và xuống, hoặc kéo một dòng. Dòng bị kéo chỉ di chuyển trong nhóm cha của chính nó, không nhảy giữa các nhóm. |
| Khôi phục mặc định | Bỏ mọi ghi đè của bạn trên toàn menu và trả lại thứ tự cùng tên mặc định. |

## Cái quyết định những gì người dùng rốt cuộc thấy

Bốn lớp, áp dụng theo thứ tự này:

1. Mặc định của sản phẩm.
2. Tài liệu này — tên bạn đổi, thứ tự bạn xếp, mục bạn tắt.
3. Phân quyền. Người dùng không đọc được một thực thể thì không bao giờ thấy dòng của nó, dù bạn có tô vẽ thế nào.
4. Thứ tự, rồi thanh bên được vẽ ra.

> [!WARNING]
> Phân quyền được kiểm tra cuối cùng, nghĩa là màn hình này chỉ ẩn được chứ không mở được gì. Một mục menu
> của module đang tắt, hay của kiểu bản ghi mà người đó không đọc được, vẫn vô hình với họ bất kể bạn đặt gì
> ở đây. Và ẩn một mục không phải là phân quyền: màn hình phía sau vẫn do server canh, nên một bookmark hay
> một URL gõ tay cũng tự bị từ chối.

## Khi nào thay đổi xuất hiện

Công bố menu sẽ xóa cache điều hướng, nên thanh bên cập nhật ở lần tải kế tiếp — thường là cú click kế tiếp,
không bao giờ phải khởi động lại. Menu được cache riêng cho từng người trong ba mươi giây, nên một trình duyệt
thứ hai có thể chậm đúng bằng mức đó.

## Có thể gặp sự cố gì

| Dấu hiệu | Nguyên nhân |
| --- | --- |
| Một mục không kéo sang nhóm khác được | Chuyển khác nhóm cha không được hỗ trợ. Hãy đổi thứ tự trong nhóm của nó. |
| Đổi tên không ăn | Bạn đã lưu một nhãn mà giao diện không có. Hãy chọn một nhãn có sẵn. |
| Người dùng nói không thấy cái bạn vừa bật | Do phân quyền của họ. Kiểm tra [người dùng, nhóm và phân quyền](admin/users-teams-roles), không phải tab này. |
| Toàn bộ menu bất ngờ trở về mặc định | **Khôi phục mặc định** đã được công bố. Lệnh này xóa ghi đè của mọi mục, chứ không phải một mục. |

## Đọc tiếp ở đâu

- [Thương hiệu, ngôn ngữ và thời gian](admin/branding-and-localization) — tên và biểu trưng bao quanh menu.
- [Thực thể, trường và bố cục](admin/entities-and-fields) — nơi chứa cấu hình điều hướng của một kiểu bản ghi.
