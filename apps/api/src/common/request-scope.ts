import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuthenticatedPrincipal {
  userId: string;
  userName: string;
  userType: 'admin' | 'regular' | 'api' | 'portal' | 'system';
  roles: string[];
  teams: string[];
  sessionId?: string;
  /** Phase 18: the portal this principal belongs to (portal users only, PLAN §37). */
  portalId?: string | undefined;
  /** Phase 18: the Contact record a portal user is (PLAN §37 contact/account relation). */
  contactId?: string | undefined;
}

interface RequestScopeState {
  requestId: string;
  principal?: AuthenticatedPrincipal;
}

export class RequestScope {
  private readonly storage = new AsyncLocalStorage<RequestScopeState>();
  private readonly fallback: RequestScopeState = { requestId: 'unknown' };

  get requestId(): string {
    return (this.storage.getStore() ?? this.fallback).requestId;
  }

  set requestId(value: string) {
    (this.storage.getStore() ?? this.fallback).requestId = value;
  }

  get principal(): AuthenticatedPrincipal | undefined {
    return (this.storage.getStore() ?? this.fallback).principal;
  }

  set principal(value: AuthenticatedPrincipal | undefined) {
    const state = this.storage.getStore() ?? this.fallback;
    if (value === undefined) delete state.principal;
    else state.principal = value;
  }

  run<T>(requestId: string, action: () => T): T {
    return this.storage.run({ requestId }, action);
  }

  runAs<T>(principal: AuthenticatedPrincipal, action: () => T, requestId = `report:${principal.userId}`): T {
    return this.storage.run({ requestId, principal }, action);
  }

  get userId(): string | undefined {
    return this.principal?.userId;
  }

  get userType(): AuthenticatedPrincipal['userType'] | undefined {
    return this.principal?.userType;
  }

  get isAdmin(): boolean {
    return this.principal?.userType === 'admin';
  }

  requirePrincipal(): AuthenticatedPrincipal {
    if (!this.principal) {
      throw new Error('No authenticated principal in request scope.');
    }
    return this.principal;
  }

  roleIds(): string[] {
    return this.principal?.roles ?? [];
  }

  teamIds(): string[] {
    return this.principal?.teams ?? [];
  }
}

export const REQUEST_SCOPE_TOKEN = Symbol('REQUEST_SCOPE');
