---
title: "antd icon buttons carry the icon's aria-label in their accessible name, not their text"
author: Jacky
date: 2026-11-05
branch: master
id: l-092ada43
scope: repo
status: active
src: agent
touches:
  - apps/api/src/ai-agents/ai-agents-module.ts
  - apps/api/test/phase19-module-declarations.test.ts
  - content/docs/en/admin/ai-agents.md
  - content/docs/en/user/ai-agents.md
  - docs/compatibility/documentation.md
  - docs/modules/crm-chat/RELEASE_NOTES.md
  - docs/reference/compatibility-matrix.md
  - packages/docs/src/corpus.test.ts
---

## Decided
- Playwright locators in this repo must not use `getByRole('button', { name: 'Save', exact: true })`-style exact matches for antd buttons that carry an icon. The icon's `aria-label` is folded into the accessible name ("plus New", "save Templates"), so an exact text match finds nothing and times out.
- Match with a boundary regex (`{ name: /\bNew\b/ }`), the `aria-label` when one is set (tooltips/settings buttons), or the visible text without exactness.

## Tried and ruled out
- `getByRole('button', { name: 'New', exact: true })` against the `/crm-chat` workspace: element never found although the button was visible with text "New". The snapshot showed the accessible name as "plus New".

## Watch out
- Buttons with an explicit `aria-label` (Diagnostics, Settings, Ask AI) match on the label alone — those are exact-safe. Only buttons relying on icon+text fold the icon in.

In the code: e2e/crm-chat.spec.ts
