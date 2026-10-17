# Service Desk — compatibility note

The canonical compatibility and deviation record lives with the module:
[`../modules/service-desk/compatibility.md`](../modules/service-desk/compatibility.md).

## Baseline references

- Case Management: https://docs.espocrm.com/user-guide/case-management/
- Emails / Email-to-Case: https://docs.espocrm.com/administration/emails/
- Knowledge Base: https://docs.espocrm.com/user-guide/knowledge-base/
- Portal and Portal Roles: https://docs.espocrm.com/administration/portal/
- Roles and ACL: https://docs.espocrm.com/administration/roles-management/
- Workflows: https://docs.espocrm.com/administration/workflows/
- Scheduled Jobs: https://docs.espocrm.com/development/scheduled-job/
- Attachments: https://docs.espocrm.com/development/attachments/
- Working-time calendar: https://docs.espocrm.com/user-guide/working-time-calendar/

## Project-specific enhancements

Queues and declarative routing, multi-target SLA clocks with business calendars and pause
accounting, scheduled warning/breach/escalation jobs, CSAT surveys and ACL-scoped service metrics are
project requirements, not claims about upstream parity.

## Compatibility position

- Behaviour is reproduced in TypeScript against this project's metadata, API, ACL, Stream, files,
  jobs, portal and reporting primitives.
- No upstream source, PHP class, schema, asset, translation or branding is copied.
- No database or source-level compatibility with EspoCRM is claimed.
- Deliberate deviations and known limitations are listed in the module compatibility document.
