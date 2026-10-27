/**
 * 19-OM.10 — the inbox filters are **server-side query parameters**, never a locally filtered list.
 *
 * The workspace never fetches everything and filters it in the browser: every control below becomes a
 * parameter of `GET action/conversations`, so the ACL, the totals and the pagination belong to the
 * server. Keeping the mapping here (instead of inline in the panel) makes that contract testable.
 */

export const STATUS_VIEWS = ['all', 'mine', 'unassigned', 'waiting_customer', 'waiting_agent', 'snoozed', 'closed'] as const;
export type StatusView = (typeof STATUS_VIEWS)[number];

export const STATUS_OPTIONS = ['open', 'pending_customer', 'pending_internal', 'resolved', 'closed', 'spam'] as const;

export interface InboxFilterState {
  readonly view: StatusView;
  readonly channel?: string | undefined;
  readonly priority?: string | undefined;
  readonly language?: string | undefined;
  readonly queueId?: string | undefined;
  readonly tag?: string | undefined;
  readonly unreadOnly?: boolean | undefined;
}

/** The saved views are server filters too, not a client-side slice. */
export function viewQuery(view: StatusView): { status?: string; assignee?: string; snoozed?: 'only' } {
  switch (view) {
    case 'mine':
      return { assignee: 'me' };
    case 'unassigned':
      return { assignee: 'unassigned' };
    case 'waiting_customer':
      return { status: 'pending_customer' };
    case 'waiting_agent':
      return { status: 'pending_internal' };
    case 'snoozed':
      return { snoozed: 'only' };
    case 'closed':
      return { status: 'closed' };
    case 'all':
    default:
      return {};
  }
}

/** The query the inbox list is fetched with — one parameter per control the agent touched. */
export function inboxQuery(state: InboxFilterState): Record<string, string | boolean> {
  const language = (state.language ?? '').trim();
  const tag = (state.tag ?? '').trim();
  return {
    ...viewQuery(state.view),
    ...(state.channel === undefined || state.channel === '' ? {} : { channel: state.channel }),
    ...(state.priority === undefined || state.priority === '' ? {} : { priority: state.priority }),
    ...(language === '' ? {} : { language }),
    ...(state.queueId === undefined || state.queueId === '' ? {} : { queueId: state.queueId }),
    ...(tag === '' ? {} : { tag }),
    ...(state.unreadOnly === true ? { unreadOnly: true } : {}),
  };
}
