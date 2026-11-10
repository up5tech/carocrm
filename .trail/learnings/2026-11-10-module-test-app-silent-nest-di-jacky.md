---
title: module-test-app silent Nest DI abort
author: Jacky
date: 2026-11-10
branch: master
id: l-cb9c4538
scope: repo
status: active
src: agent
touches:
  - apps/api/test/module-test-app.ts
---

apps/api/test/module-test-app.ts boots AuthController in a throwaway Nest module; any new AuthController constructor dependency must be added to its providers or every module-barrel suite aborts the whole vitest worker during Nest init. abortOnError:true + logger:false masked the DI error as a bare 'Channel closed' crash; the harness now uses abortOnError:false so DI breaks surface as ordinary test failures. Also: ai-agent-triggers.test.ts flakes under the shared primary DB (event-trigger fan-out is capped at the first 5 published candidates ordered by id, and per-user run limits are shared across suite runs) — passes standalone.
