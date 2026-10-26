---
title: "Phase 20 axe audit via @axe-core/playwright, not jsdom"
author: Jacky
date: 2026-10-26
branch: master
cost: { minutes: 95 }
id: l-8f2267db
scope: repo
status: active
src: agent
touches:
  - apps/web/src/theme/tokens.ts
  - e2e/accessibility.spec.ts
  - apps/web/src/theme.ts
  - apps/web/src/styles/carocrm.css
  - apps/web/src/pages/EntityListPage.tsx
---

decided     The 20.16 'axe passes on the four core surfaces' criterion is closed with @axe-core/playwright (one dep) scanning real rendered pages in e2e/accessibility.spec.ts — NOT jsdom+vitest-axe. The §20.26 'dependency-gated' note assumed jsdom was the only path; Playwright reuses the existing e2e webServer and audits what users actually render.
decided     WCAG-contrast fixes go through tone migrations, not exclusions: itemSelectedColor moves to each accent tone's *strong* value (plain accent on its soft selection background is 2.98:1); theme.ts colorPrimary/colorLink/colorTextDescription follow the strong/ink-secondary values (antd's own description ink over white is 2.47:1); ink secondary+muted become 66707a, faint 6e7681, updated in BOTH theme/tokens.ts and the generated styles/tokens.css — those two are the only files allowed hex, and the convention gate flags hex even inside code comments.
watch out   axe resolves combobox inputs by accessible name: aria-label on an antd Select DOES reach its input (rc-select domProps route), but row-selection checkboxes need getCheckboxProps returning an aria-label cast as Partial of CheckboxProps — antd's type does not declare ARIA even though it forwards to the input.
watch out   antd tables render an aria-hidden measure row still carrying tabindex=-1; axe flags aria-hidden-focus until CSS visibility hides it (display:none breaks the column-width measurement the row exists for).
watch out   locate antd data rows by 'tbody tr[data-row-key]' — the measure row also matches 'tbody tr', and getByRole('row') can land on the header row; the record/view table carries no 'grid' ARIA role despite looking like one.
watch out   status pills: each green/amber/red variant needs its own text over its pale tint background; the state tokens fail there (2–4:1) — darker tints 1e7d46/8a6116/b0303a were added to tokens.css for exactly that.
rule        Before a plan note says a UI feature is 'not built', diff the claim against the working tree — UI deferral lists here drifted within days because shipped fixes landed without reconciling the docs; the reconciliation section is only as fresh as its last manual pass.
