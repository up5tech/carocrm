-- Phase 20 deferral cleanup — retire preference names no route reads or writes any more.
--
-- `detailTabs` was the first implementation of 20.18 (relation-tab arrangement); `RelationTabs` now
-- stores through the documented `relationTabs` name, and the metadata schema owns the real
-- validation. `dismissedSetupSteps` never gained a writer: the checklist banner dismisses through
-- the `setupChecklistDismissed` boolean instead (SetupBanner.tsx).
--
-- The predicate is exact (AGENTS.md §3.5): only these two keys of `user_preferences` are touched —
-- no other preference, no other table. Both names are unreachable in the codebase (no reader, no
-- writer), so the rows are dead state and a user of them cannot lose anything they could ever see.

DELETE FROM user_preferences WHERE name IN ('detailTabs', 'dismissedSetupSteps');
