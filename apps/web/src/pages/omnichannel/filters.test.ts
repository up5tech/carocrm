import { describe, expect, it } from 'vitest';

import { inboxQuery, viewQuery } from './filters.js';
import { errorText, refusalSentence } from './refusals.js';

/**
 * 19-OM.10 / OM.14 — the workspace's two pure contracts.
 *
 * 1. **The filters are server parameters.** The inbox never fetches a list and filters it in the
 *    browser, so every control the agent touched has to appear in the query — and a control the
 *    agent did not touch must not (an empty filter would narrow the server's answer by accident).
 * 2. **A refusal reads as a reason.** The server sends codes; the catalogue turns them into a
 *    sentence. A code with no sentence falls back to the code itself — never to a raw key path.
 */
describe('inbox filters (19-OM.10)', () => {
  it('turns every control into a query parameter', () => {
    const query = inboxQuery({
      view: 'all',
      channel: 'whatsapp',
      priority: 'urgent',
      language: 'en',
      queueId: 'queue_1',
      tag: 'billing',
      unreadOnly: true,
    });
    expect(query).toEqual({
      channel: 'whatsapp',
      priority: 'urgent',
      language: 'en',
      queueId: 'queue_1',
      tag: 'billing',
      unreadOnly: true,
    });
  });

  it('leaves an untouched control out of the query', () => {
    const query = inboxQuery({ view: 'all', language: '  ', tag: '', channel: undefined, priority: undefined, queueId: undefined, unreadOnly: false });
    expect(query).toEqual({});
  });

  it('maps a saved view to a server filter', () => {
    expect(viewQuery('mine')).toEqual({ assignee: 'me' });
    expect(viewQuery('unassigned')).toEqual({ assignee: 'unassigned' });
    expect(viewQuery('snoozed')).toEqual({ snoozed: 'only' });
    expect(viewQuery('closed')).toEqual({ status: 'closed' });
    expect(viewQuery('all')).toEqual({});
    expect(inboxQuery({ view: 'mine' })).toEqual({ assignee: 'me' });
  });
});

describe('refusals (19-OM.14)', () => {
  it('shows the code itself when the catalogue has no sentence for it', () => {
    // The catalogues are not loaded in this environment, so `t` falls back to the key; the helper
    // must then return the bare code rather than the key path.
    expect(refusalSentence('no_such_code')).toBe('no_such_code');
    expect(refusalSentence('no_such_code')).not.toContain('omnichannel.refusal.');
  });

  it('carries the refusal reasons next to the message', () => {
    const error = Object.assign(new Error('This message is not permitted.'), {
      body: { error: { message: 'This message is not permitted.', details: { refusals: ['consent_required', 'quiet_hours'] } } },
    });
    const text = errorText(error, 'omnichannel.inbox.actionFailed');
    expect(text).toContain('This message is not permitted.');
    expect(text).toContain('consent_required');
    expect(text).toContain('quiet_hours');
  });

  it('falls back to the fallback sentence when the error carries nothing', () => {
    expect(errorText(new Error('boom'), 'omnichannel.inbox.actionFailed')).toBe('boom');
    expect(errorText({}, 'omnichannel.inbox.actionFailed')).toBe('omnichannel.inbox.actionFailed');
  });
});
