---
title: API key
summary: Thông tin xác thực cho một hệ thống khác, cách nó được cấp, cách nó xác thực, và cách cho nghỉ một key.
audience: admin
order: 50
tags: [api, keys, integration, security]
related: [admin/users-teams-roles, admin/settings-overview]
updated: 2026-10-21
---

**Mở màn hình này:** [API key](/admin/settings/apiKeys).

Một API key thuộc về một **tài khoản API**, tức là một bản ghi rất giống người dùng: nó có tên đăng nhập và nó
có phân quyền. Key đó mạnh tới đâu chỉ tùy thuộc tài khoản sở hữu nó.

> [!NOTE]
> Bản cài đặt này không có scope, không có hạn dùng và không có mô tả riêng cho từng key. Một key không thể
> hẹp hơn tài khoản của nó, và nó không ngừng hoạt động vào một ngày nào đó. Tất cả những điều đó do phân
> quyền trên tài khoản quyết — xem [người dùng, nhóm và phân quyền](admin/users-teams-roles).

## Cấp một key

Tạo tài khoản, gán cho nó các phân quyền cần thiết, và phản hồi sẽ kèm theo một secret. Đó là khoảnh khắc duy
nhất secret tồn tại ở dạng đọc được.

| Thành phần | Hình dáng |
| --- | --- |
| Key id | Một định danh công khai ngắn, `key_` nối tiếp chuỗi hex. Đưa vào log được. |
| Secret | Một chuỗi ngẫu nhiên dài. Hiện đúng một lần, chỉ lưu dưới dạng hash, không bao giờ lấy lại được. |

Hộp thoại hiển thị chúng giữ một giá trị ghép `keyId:secret` để bạn sao chép. Hãy chép nó vào trình quản lý
secret của bạn **ngay bây giờ**: đóng hộp thoại là không rút lại được, và các màn hình bản ghi về sau chỉ còn
hiện key id, ngày tạo, lần dùng cuối và key còn hiệu lực hay đã bị thu hồi.

## Dùng một key

Bên gọi gửi đúng một header trong mỗi yêu cầu:

```text
Authorization: ApiKey keyId:secret
```

Sai định dạng, key đã thu hồi, secret không khớp hash của nó, hay tài khoản ngưng hoạt động — tất cả đều bị từ
chối bằng cùng một câu trả lời chung chung. Mỗi cuộc gọi được chấp nhận sẽ đóng dấu thời gian **lần dùng cuối**
của key, đó là cách bạn biết một key còn sống hay không trước khi thu hồi nó.

Key của một tài khoản giữ vai trò quản trị hệ thống sẽ đăng nhập với quyền quản trị, nên hãy đối xử với việc
gán đó như cách bạn đối xử với một quản trị viên là con người.

## Đổi và thu hồi

- **Đổi key** vừa cấp một key mới vừa thu hồi key cũ trong cùng một thao tác. Hãy làm vậy khi một người rời
  nhóm từng dùng key, hoặc khi có bất kỳ nghi ngờ nào về rò rỉ.
- **Thu hồi** đánh dấu key là đã bị thu hồi. Nó ngừng hoạt động ngay và không thể gỡ việc thu hồi.

> [!WARNING]
> Thu hồi không hoàn tác những gì key đã làm, và không đụng tới bất kỳ key nào khác của cùng tài khoản. Nếu
> secret bị lộ, hãy đổi mọi key mà tài khoản có và sửa phân quyền của tài khoản.

## Có thể gặp sự cố gì

| Dấu hiệu | Nguyên nhân |
| --- | --- |
| `Invalid API key format.` | Header không phải `ApiKey keyId:secret` — thiếu một dấu cách, hoặc là bearer token. |
| `Invalid API key.` | Đã thu hồi, secret sai, hoặc tài khoản ngưng hoạt động. Thông báo không phân biệt chúng, và đó là chủ ý. |
| Một cuộc gọi trước đây chạy được nay thất bại | Tài khoản bị ngưng hoạt động hoặc bị đổi phân quyền. |
| Bạn làm mất secret | Đúng như thiết kế. Hãy cấp một key mới. |

## Đọc tiếp ở đâu

- [Người dùng, nhóm và phân quyền](admin/users-teams-roles) — phân quyền trên một tài khoản API thực sự cho phép gì.
- [Nhật ký kiểm toán](/admin/audit-log) — một tài khoản đã làm gì.
