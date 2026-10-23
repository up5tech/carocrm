---
title: Files and storage
summary: Where uploaded files live, the limits that really apply, the attachments tab, and what cleans up abandoned uploads.
audience: admin
order: 90
tags: [files, attachments, upload, storage, retention]
aliases: ["lưu trữ tệp", "đám mây lưu trữ", "đính kèm tệp"]
related: [admin/settings-overview, admin/authentication-and-security, admin/entities-and-fields, user/record-page, admin/workflows-and-processes]
updated: 2026-10-21
---

Open [Administration → Attachments](/admin/settings/attachments). The tab edits the `fileStorage`
document: a maximum upload size and a list of allowed extensions, behind the usual publish bar. What the
server really enforces is a mix of that document's siblings in code and of the deployment configuration —
read this page before you rely on a number you set here.

> [!WARNING]
> Nothing reads the `fileStorage` document. No upload path, request limit or storage driver consults it,
> so a value you publish here changes what the tab displays and nothing else. The limits that do apply are
> the ones below, from the server configuration and the attachment service.

## What the tab shows

| Control | Field | Accepted | Default |
| --- | --- | --- | --- |
| Maximum upload size (MB) | `maxUploadSizeMb` | integer 1 to 2048 | 25 |
| Allowed extensions | `allowedExtensions` | up to 200 entries, 1 to 16 characters, lowercase letters and digits | `png`, `jpg`, `jpeg`, `gif`, `webp`, `pdf`, `csv`, `xlsx`, `docx` |

Type an extension and press Enter to add it; the tab strips anything that is not a lowercase letter or
digit. The footer states plainly that the storage driver and its location come from the server
configuration and are not editable here.

## The limits that apply

| Limit | Source | Value |
| --- | --- | --- |
| Whole-file ceiling | `UPLOAD_MAX_MB` | 1 to 2000 MB, default 25; enforced while the body streams |
| Chunk ceiling | `UPLOAD_CHUNK_MAX_MB` | 1 to 128 MB, default 8, for the chunked upload API |
| Download link lifetime | `SIGNED_URL_TTL_SECONDS` | 30 to 86 400 seconds, default 900 |
| Driver | `STORAGE_DRIVER` | `local`, `s3` or `minio` |
| Local path | `STORAGE_ROOT` | `.data/files` unless the deployment says otherwise |
| Object storage | `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | only used by the `s3` and `minio` drivers |
| Scan | `MALWARE_SCAN_MODE` | `signature` (the built-in scanner) or `none` |

`GET /api/v1/Attachment/action/info` answers with the driver, whether it supports signed URLs, the byte
ceiling and the scanner name — that is the shape the client reads, and it reflects the configuration, not
the tab.

## What an upload must pass

Every upload is checked in this order, and each refusal is a validation error naming the file:

- The name must be non-empty and is reduced to its base name, so a path cannot smuggle a location.
- Ten extensions are always refused whatever the declared type says: `.exe`, `.sh`, `.bat`, `.cmd`,
  `.js`, `.jar`, `.msi`, `.apk`, `.dll`, `.so`.
- The declared MIME type must be an image or text type, or one of pdf, json, zip, msword, ms-excel,
  ms-word, docx, xlsx, pptx.
- A declared size above the ceiling is refused before bytes move; a body that grows past the ceiling
  while streaming is cut off, and an empty file is refused.
- The malware scanner runs before the row is written. A dirty result deletes what was stored and the
  upload fails with the provider's reason.

To change which extensions pass, change the deployment or the code that owns the allowlist — not this tab.

## How files are addressed

An attachment belongs to a parent record and a field. Uploads go to `POST /api/v1/Attachment/upload` as
multipart with the file in a part named `file`, plus `parentId`, `parentType`, `field`, an optional `role`,
and an optional declared `size` as text fields or query parameters. Reading is separate from bytes:

- `GET /api/v1/Attachment/:id` — metadata only.
- `GET /api/v1/Attachment/:id/file` — the bytes, streamed.
- `GET /api/v1/Attachment/:id/url` — a time-limited link on drivers that support it.
- `DELETE /api/v1/Attachment/:id` — the uploader or an administrator; removes the stored bytes and the row.

Read access to the parent record gates uploads, downloads and metadata reads. A record you cannot read has
attachment ids you cannot pull bytes from.

Large files use the chunked flow: `POST /api/v1/AttachmentUpload/init` reserves an upload and stamps an
expiry 24 hours later, `POST /AttachmentUpload/:id/part` sends parts within the chunk ceiling,
`POST /AttachmentUpload/:id/complete` assembles them, and `:id/abort` ends it early. An interrupted
upload is abandoned by the `system.cleanupUploads` job after its reservation expires plus a two-hour
grace, which removes the part files; the job only exists in a worker that can reach the storage.

## Retention

Finished attachments are kept until someone deletes them through a record or the delete endpoint — there
is no shipped job that prunes stored files, so disk and bucket growth is a capacity matter for the
deployment. The periodic cleanups that do exist prune expired sessions, outbox events and workflow run
history; see [Authentication and security](admin/authentication-and-security) and
[Workflows and processes](admin/workflows-and-processes).

> [!NOTE]
> Avatars and the product logo are attachments. The logo field on
> [Branding, language and time](admin/branding-and-localization) stores an attachment id, so a logo that
> will not upload is subject to the same allowlist as any other file.

## Where to go next

- [Entities, fields and layouts](admin/entities-and-fields) — adding an attachment field to a record type.
- [Record page](user/record-page) — where people upload and download.
- [The administration area](admin/settings-overview) — how a document tab saves and conflicts.
