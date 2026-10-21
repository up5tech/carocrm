---
title: Người dùng, nhóm và phân quyền
summary: Thêm một người, đặt mật khẩu cho họ, và quyết định những gì họ được thấy và được làm.
audience: admin
order: 40
tags: [users, teams, roles, acl]
related: [admin/api-keys, admin/settings-overview]
updated: 2026-10-21
---

Quyền truy cập trong CRM này do ba thứ quyết định: **người dùng**, các **nhóm** mà họ thuộc về, và các
**phân quyền** mang theo quyền. Cả ba đều là màn hình bản ghi — mỗi thay đổi tự lưu riêng, không có thanh lưu.

**Mở các màn hình này:** [Người dùng](/admin/settings/users), [Nhóm](/admin/settings/teams),
[Phân quyền](/admin/settings/roles).

## Thêm người dùng

Trên tab Người dùng, tạo bản ghi và điền:

1. **Tên đăng nhập** — cái họ gõ ở màn hình đăng nhập. Không phải địa chỉ email của họ.
2. **Họ tên, Tên, Email, Điện thoại, Chức vụ** — những gì đồng nghiệp nhìn thấy.
3. **Mật khẩu** — khi tạo thì có thể để trống. Để trống thì người này chưa đăng nhập được cho tới khi bạn đặt một mật khẩu.
4. **Quản trị** — chuyển tài khoản sang cấp quản trị, tức là mở [khu quản trị](admin/settings-overview).
5. **Hoạt động** — tài khoản ngưng hoạt động không đăng nhập được; các bản ghi của họ vẫn ở nguyên chỗ cũ.
6. **Phân quyền** và **Nhóm** — gán ngay trên cùng biểu mẫu.

Tài khoản có ba loại: người dùng thường, tài khoản quản trị, và người dùng portal bị gắn vào một cổng cùng một
bản ghi liên hệ.

## Đặt hoặc đặt lại mật khẩu

Mở người dùng và dùng hộp thoại mật khẩu: nhập mật khẩu mới hai lần, tối thiểu tám ký tự.

> [!WARNING]
> Đặt mật khẩu sẽ kết thúc mọi phiên của tài khoản đó, trên mọi thiết bị. Hãy báo cho người đó trước khi làm,
> và coi việc đặt lại là câu trả lời cho một mật khẩu đã quên — không có chức năng tự đặt lại để họ tự dùng.

## Quản trị viên cuối cùng

Một tài khoản được tính là quản trị khi nó đang hoạt động và được đánh dấu quản trị, hoặc thuộc kiểu admin,
hoặc giữ vai trò quản trị hệ thống. Từ chối sửa tài khoản duy nhất như vậy là một quy tắc, không phải một sở
thích:

```text
Đây là tài khoản quản trị cuối cùng, nên không thể hạ quyền, ngưng hoạt động hay xóa.
```

Bước kiểm tra chạy trên trạng thái *sau* thay đổi của bạn, và đó chính là thứ chặn cảnh khoá chặt khi bạn gỡ
phân quyền khỏi quản trị cuối đồng thời đặt người đó thành ngưng hoạt động trong cùng một lần lưu.

## Phân quyền

Một phân quyền là một ma trận: cho mỗi thực thể, cho mỗi hành động, một mức.

| Hành động | Mức |
| --- | --- |
| create, read, edit, delete, stream | yes (mọi thứ), all, team, own, no |

`team` là các bản ghi thuộc những nhóm mà người dùng tham gia; `own` là các bản ghi do người dùng tạo hoặc
được gán cho họ. Một ô bạn để trống sẽ được lưu dưới dạng không có gì, chứ không phải một lời từ chối — đó là
lý do JSON của một phân quyền luôn nhỏ.

Một phân quyền còn giới hạn được **trường**: theo từng thực thể, mỗi trường có một mức đọc và một mức sửa. Một
trường bạn không được đọc sẽ bị gỡ khỏi bản ghi trước khi nó tới trình duyệt — không chỉ đơn thuần là ẩn đi.

Phân quyền đang được gán cho một người dùng, một tài khoản API hay một nhóm thì không xóa được. Hãy gỡ việc
gán trước.

## Nhóm

Một nhóm gồm tên, danh sách thành viên, các phân quyền áp dụng **thông qua** nó, và một cờ riêng tư tùy chọn.
Bảng quan hệ thành viên mới là nguồn chuẩn: danh sách thành viên lưu cùng nhóm chỉ là bản sao của nó, nên một
người đã có trong bảng quan hệ thành viên thì thuộc nhóm, bất kể danh sách kia nói gì.

Xóa một nhóm thì gỡ quan hệ thành viên và các liên kết phân quyền của nhóm đó. Những bản ghi từng chia sẻ với
nhóm vẫn giữ tham chiếu — chúng không tự quay về chủ sở hữu.

## Có thể gặp sự cố gì

| Dấu hiệu | Nguyên nhân |
| --- | --- |
| Một người thấy thanh bên ngắn hơn bạn | Do phân quyền của họ, hoặc do [menu chính](admin/main-menu) — phân quyền áp dụng sau cùng. |
| Bản ghi mở được nhưng thiếu một trường | Quyền đọc theo trường trong phân quyền của họ. |
| Xóa người dùng bị từ chối | Đó là chính tài khoản của bạn. Hãy đăng nhập bằng người khác. |
| Hộp thoại mật khẩu bị từ chối | Dưới tám ký tự, hoặc hai lần nhập không khớp. |
| Danh sách phân quyền trong ô chọn bị trống | Ô chọn chỉ đọc một cửa sổ bản ghi giới hạn, không đọc toàn bảng. |

## Đọc tiếp ở đâu

- [API key](admin/api-keys) — một tài khoản không phải con người.
- [Thương hiệu, ngôn ngữ và thời gian](admin/branding-and-localization) — những ngôn ngữ người dùng của bạn được chọn.
