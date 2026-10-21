---
title: Projects
summary: Plan, board, Gantt, members and settings — the project record and the five screens around it, and the rules the server enforces.
audience: user
order: 100
tags: [projects, tasks, board, gantt, plan, members]
related: [user/record-page, user/lists-and-views, user/activities-and-tasks, admin/entities-and-fields]
updated: 2026-10-21
---

A project is a record you open from the [Project list](/Project), plus five purpose-built screens around
it: **Plan**, **Board**, **Gantt**, **Members** and **Settings**, reached from tabs on the project. The
header is an ordinary [record page](user/record-page) — name, description, a start date, an end date, a
category and an accountable owner. Dates are whole calendar days, not times, and an end date can never
precede its start.

> [!NOTE]
> A project's board is chosen when it is created and cannot be changed afterwards. The board defines the
> columns and the status each column means.

## Plan

The Plan is the list of work. A project groups its tasks — group types are `Triage`, `Backlog`, `Work`,
`Phase` and `Sprint` — and you add groups, rename them, reorder them and set a default group for new
tasks. Inside a group you create tasks, subtasks and milestones and drag them to reorder. A group that
still holds tasks cannot be deleted; move its tasks first, and an empty group is removed immediately.

A task carries a stage, an assignee, a start and end date, and — when the project enables them — a
priority, points, or estimated hours. Its status is not typed: it is derived from the stage, from the set
`Not Started`, `Started`, `Completed`, `Canceled`, `Deferred`.

## Board

The Board is a column per stage of the project's board, showing one group at a time. Dragging a card to
another column asks the server to change its stage, which maps to the status and is checked against the
dependency, subtask and role rules. The drop is a request, not an authority: if the server refuses, the
card returns to where it was allowed.

## Gantt

The Gantt draws task bars across a timeline and is available when the project's **Gantt view** feature is
on (it is on by default). It shows the `Work`, `Phase` and `Sprint` groups. You drag a bar to move it,
drag an edge to change its dates, and click a dependency line to edit it. Milestones sit as single points,
never as durations.

## Members and access

A member belongs to a project with a role. Three roles are built in — Owner, Editor and Member — and an
administrator can add more. The person who creates a project automatically becomes its first Owner, and
the last owner cannot be removed until ownership is transferred. A task can only be assigned to someone
who is a member.

Access composes in one order: the global permissions apply first, then the member's project role **narrows**
what they may do inside the project; a non-member keeps the global scope, and a global `all` grant or an
administrator is not narrowed at all.

## Settings

Settings turn project features on and off. **Priority** and **Gantt view** are on by default; task
**dependencies**, **collaborators**, **points** and **estimated hours** are off until you enable them per
project.

> [!WARNING]
> Turning a feature off hides its control and makes the API refuse writes to it, but the stored values are
> kept, not erased.

You also set the default group for new tasks here, and **clone** the project. A clone copies groups,
tasks, subtasks, milestones and dependencies under new ids, and can copy members with their roles and the
task owners; assignees and attachments are not copied unless asked. Dates shift by the distance between
the old start date and the new one.

## Rules the server enforces

These hold whether you act through a project screen or the generic record API:

- a task with subtasks that are not completed or cancelled cannot be completed, and a subtask cannot be
  changed while its parent is completed;
- a milestone cannot have subtasks and cannot be a dependency predecessor;
- dependencies link tasks of the same project only and can never form a cycle — there are no
  cross-project dependencies;
- a project that still has tasks cannot be deleted, and neither can a board a project uses or a stage a
  task sits in.

## Where to go next

- [Record page](user/record-page) — the project header, its relations and its stream.
- [Lists and views](user/lists-and-views) — filtering projects by owner and category.
- [Activities, tasks and the calendar](user/activities-and-tasks) — how a project task differs from a CRM task.
