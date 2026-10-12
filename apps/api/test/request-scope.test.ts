import { describe, expect, it } from 'vitest';

import { RequestScope } from '../src/common/request-scope.js';

describe('RequestScope', () => {
  it('isolates concurrently running principals and supports trusted actor rehydration', async () => {
    const scope = new RequestScope();
    const [first, second] = await Promise.all([
      scope.run('request-one', async () => {
        scope.principal = { userId: 'user-one', userName: 'one', userType: 'regular', roles: ['sales'], teams: ['north'] };
        await Promise.resolve();
        return { requestId: scope.requestId, userId: scope.userId, roles: scope.roleIds() };
      }),
      scope.run('request-two', async () => {
        scope.principal = { userId: 'user-two', userName: 'two', userType: 'regular', roles: ['support'], teams: ['south'] };
        await Promise.resolve();
        return { requestId: scope.requestId, userId: scope.userId, roles: scope.roleIds() };
      }),
    ]);
    expect(first).toEqual({ requestId: 'request-one', userId: 'user-one', roles: ['sales'] });
    expect(second).toEqual({ requestId: 'request-two', userId: 'user-two', roles: ['support'] });

    const scheduledActor = await scope.runAs({ userId: 'owner', userName: 'owner', userType: 'regular', roles: ['current-role'], teams: [] }, async () => ({
      requestId: scope.requestId,
      userId: scope.requirePrincipal().userId,
      roles: scope.roleIds(),
    }), 'scheduled-report-unique-run');
    expect(scheduledActor).toEqual({ requestId: 'scheduled-report-unique-run', userId: 'owner', roles: ['current-role'] });
  });
});
