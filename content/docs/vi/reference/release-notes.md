---
title: Có gì mới
summary: Trong ứng dụng không có màn hình changelog. Ghi chú phát hành là các tài liệu trong kho mã nguồn — ở đây là nơi chúng nằm và cách đọc.
audience: user
order: 50
tags: [release, notes, version, changelog]
aliases: ["ghi chú phát hành", "thay đổi theo phiên bản"]
related: [reference/glossary, admin/settings-overview, getting-started/find-your-way]
updated: 2026-11-15
---

Trong ứng dụng không có gì mở ra danh sách những gì đã thay đổi. Không có màn hình **Có gì mới**,
không có biểu ngữ phiên bản và không có thông báo nâng cấp: cẩm nang bạn đang đọc mô tả bản dựng
như nó hoạt động hôm nay, và nói rõ chỗ nào một tính năng không tồn tại thay vì hứa sẽ có sau.

## Ghi chú phát hành nằm ở đâu

Chúng là tài liệu kỹ thuật trong kho mã nguồn, không phải trang của cẩm nang này, nên được viết cho
người bảo trì phiên bản của bạn.

| Tài liệu | Là gì | Mục ghi ngày mới nhất |
| --- | --- | --- |
| `docs/releases/2026-11-15-phase-24.md` | Ghi chú trung gian về hoàn thiện sản phẩm: hiến chương single-tenant, artefact cài đặt production và những gì còn mở. | 2026-11-15. |
| `docs/releases/2026-11-13-phase-23.md` | Ghi chú phát hành tăng cường bảo mật: các kiểm soát đã kiểm chứng, migration 089–094, việc vận hành cần làm và quyết định NO-GO. | 2026-11-13. |
| `docs/releases/2026-10-29-phase-22.md` | Ghi chú phát hành tăng cường cho toàn sản phẩm: phạm vi đã kiểm chứng, migration, việc vận hành cần làm và các blocker còn lại. | 2026-10-29. |
| `docs/modules/crm-chat/RELEASE_NOTES.md` | Ghi chú phát hành của một module, theo phiên bản. | v1.1, phát hành 2026-10-21. |
| `docs/implementation/service-desk-release.md` | Checklist phát hành của một module: mọi phân phase, trạng thái và các lệnh chứng minh. | Ngày tham chiếu phát hành 2026-10-17. |
| `docs/reference/alpha-status.md` | Báo cáo trạng thái toàn sản phẩm: từng khả năng, trạng thái và bằng chứng, rồi các độ lệch có chủ đích. | 2026-10-12, có bổ sung các phase sau. |
| `docs/compatibility/<area>.md` | Ghi chú giới hạn đã biết của một khu vực: phần nào cố ý không tương đương, và phần nào chưa xây. | Viết theo từng khu vực nên không có một ngày chung. |

## Cách đọc một ghi chú

Một ghi chú trong kho này được viết như bằng chứng, không như tài liệu quảng cáo. Bốn phần đáng để ý:

- **Bảng kiểm chứng.** Các lệnh thực sự đã chạy và con số trả về. Một khẳng định không có dòng ở
  đây là đã được rà soát, chưa được kiểm thử — các ghi chú nói rõ khi trường hợp đó xảy ra.
- **Bảng phát hiện và sửa.** Khi một ghi chú trước khẳng định điều chưa được xây, ghi chú mới nêu
  tên khoảng trống và những gì đã đổi. Đó là lý do văn phong có thể thẳng thắn.
- **Danh sách chưa xây và giới hạn đã biết.** Phần hữu ích nhất với người đọc: sản phẩm không làm
  gì, được nêu như sự thật.
- **Cặp phiên bản.** Phiên bản module và phiên bản contract là hai con số riêng, nên một tính năng
  có thể đến mà contract không đổi. Đọc cả hai trước khi kết luận về tương thích.

## Bản phát hành gần nhất

Ghi chú có ngày mới nhất là **ghi chú trung gian hoàn thiện sản phẩm Phase 24**, 2026-11-15, với
**bản phát hành tăng cường bảo mật Phase 23**, 2026-11-13, ngay sau đó. Phase 24 vẫn đang chạy:
nó phê chuẩn single-tenant làm ranh giới sản phẩm, cung cấp artefact cài đặt production và sửa tài
liệu phát hành, trong khi quyết định phát hành vẫn là **NO-GO cho production** — cùng các blocker
về backup, giấy phép và exception chưa ký như Phase 23. Điều người đọc có thể nhận thấy:

| Bạn thấy | Điều đó nghĩa là |
| --- | --- |
| Tài liệu giờ nói một lần triển khai phục vụ một tổ chức | Single-tenant là ranh giới đã quyết định, không phải tính năng còn thiếu. |
| Topology Compose production và Dockerfile đã có trong kho mã nguồn | Artefact cài đặt/nâng cấp đã được cung cấp; chưa có lần triển khai nào được thực hiện. |
| Cẩm nang và README nêu đúng số migration và khả năng | Ghi chú phát hành, trang trạng thái và README mô tả đúng bản dựng thực tế. |

Ghi chú Phase 23 vẫn là ghi chú phát hành *hoàn chỉnh* gần nhất. Nó tăng cường đăng nhập, phiên,
API key và đầu vào không tin cậy, và đổi việc người vận hành phải làm trước khi mang dữ liệu khách
hàng thật. Điều người đọc có thể nhận thấy:

| Bạn thấy | Điều đó nghĩa là |
| --- | --- |
| Bị khóa sau nhiều lần đăng nhập sai, và tự đặt lại mật khẩu | Đăng nhập sai bị giới hạn theo nguồn và theo tài khoản; token đặt lại dùng một lần và có hạn. |
| Bị yêu cầu MFA khi chính sách của phiên bản yêu cầu | `security.mfa.required` có thể bắt buộc TOTP cho admin hoặc mọi người. |
| API key xoay được, có phạm vi và giới hạn theo IP | Key mang scope `read`/`write`, `last_used_at` và giới hạn CIDR tùy chọn; secret chỉ hiện một lần. |
| Phiên bản production từ chối khởi động với secret giữ chỗ | Guard khởi động từ chối JWT secret dev, `ENCRYPTION_KEY` rỗng và chế độ tin cậy extension khác `enforce`. |
| Attachment và export tôn trọng cùng quyền với bản ghi | Đọc attachment yêu cầu ACL của bản ghi cha và export CSV bỏ trống cột bị cấm đọc. |

> [!WARNING]
> Cả ghi chú Phase 23 và Phase 24 đều ghi nhận bản phát hành **bị chặn cho production** (NO-GO):
> vẫn chưa có diễn tập restore và chưa có RPO/RTO được duyệt, chưa có quyết định `LICENSE`/phân phối,
> và các exception mức High/Critical vẫn chờ chủ sở hữu ký. Artifact backup có thể ghi được; chưa có
> restore đã kiểm chứng. Mỗi ghi chú nêu các khoảng trống còn mở kèm chủ sở hữu và ngày rà soát.

### Bản phát hành module gần nhất

Các bản phát hành module mới nhất là CRM Chat v1.3.0 và AI Agents v1.3.0, cả hai ngày 2026-11-06. Bản
Chat thêm các domain tool phía đọc (trạng thái project, tóm tắt thương mại, hiệu suất campaign,
danh sách email) và AI nội tuyến: panel quick-chat giờ mở từ header bản ghi và thanh bulk của danh
sách với bản ghi/lựa chọn làm ngữ cảnh, trình thiết kế mẫu email liên kết tới **Draft with AI**, và
trang chủ có thêm thẻ briefing xác định. AI Agents v1.3.0 thêm ba loại trigger — sự kiện, theo lịch
và tích hợp — nên một agent đã publish có thể chạy mà không ai bấm **Run**. Điều thay đổi với người
đọc [CRM chat](/crm-chat):

| Bạn thấy ở [CRM chat](/crm-chat) | Điều đó nghĩa là |
| --- | --- |
| Câu trả lời có thể dùng số liệu project, bán hàng và campaign | Các domain tool phía đọc đã vào catalogue, chạy dưới quyền của chính bạn. |
| Panel **Ask AI** mở từ bản ghi hoặc danh sách kèm gợi ý | Inline AI dùng lại cùng turn API và ACL; ngữ cảnh nằm trong prompt, không phải quyền rộng hơn. |
| Có một run mà không ai chạy bằng tay | Một trigger đã kích hoạt, với tư cách người publish agent. Xem [AI agents](user/ai-agents). |

## Cẩm nang này làm gì thay thế

Vì không có changelog để đọc, cẩm nang tự mang các tín hiệu độ mới:

- Mỗi trang kết thúc bằng ngày **Last reviewed**, và danh sách recently-reviewed ở trang chủ sắp xếp
  theo ngày đó, nên một trang lâu chưa được rà lại hiện ra đúng như vậy.
- Sự vắng mặt được ghi lại thay vì làm mờ. Các trang nêu rõ không có chuông thông báo, không có tự
  đặt lại mật khẩu, không có trình chọn file khi import và không có bulk update — những thứ mà một
  ghi chú phát hành thường bị đổ là bỏ sót.
- Quản trị viên có thể xem mức độ đã dịch của kho nội dung và trang nào mang cảnh báo
  content-contract trên tab [Docs](/admin/settings/docs) của khu vực quản trị.

> [!NOTE]
> Ghi chú phát hành không phải lời hứa về phiên bản của bạn. Các tài liệu này mô tả mã nguồn; bạn
> click được gì phụ thuộc vào bản dựng quản trị viên triển khai và các công tắc phiên bản đó bật.
> Nếu ghi chú phát hành và màn hình của bạn không khớp, màn hình là sự thật — và
> [khu vực quản trị](admin/settings-overview) giải thích màn hình nào bị chặn theo phiên bản.

## Đi tiếp ở đâu

- [Bảng thuật ngữ](reference/glossary) — những từ mà ghi chú phát hành dùng cho thứ nó đã đổi.
- [Câu hỏi thường gặp](reference/faq) — những câu hỏi mà một bản phát hành mới thường nêu ra.
- [Khu vực quản trị](admin/settings-overview) — cách cài đặt được đánh phiên bản và publish trên phiên bản của bạn.
