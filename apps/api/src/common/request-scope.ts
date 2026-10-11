export interface AuthenticatedPrincipal {
  userId: string;
  userName: string;
  userType: 'admin' | 'regular' | 'api' | 'portal' | 'system';
  roles: string[];
  teams: string[];
  sessionId?: string;
}

export class RequestScope {
  requestId = 'unknown';
  principal?: AuthenticatedPrincipal;

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
