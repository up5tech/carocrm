// GENERATED FILE — do not edit. Regenerate with: node scripts/generate-api-client.mjs
// Source: api-spec/*.yaml entries carrying operationId + requestSchema/responseSchema.
// Phase 24.4 (PLAN_Phase_24_Product_Completion.md §10): the schema-backed canonical contract.

export interface ApiTransport {
  request<TResponse = unknown>(options: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  }): Promise<TResponse>;
}

export type LoginChallengeRequest = {
  "challengeId": string;
  "code": string;
};

export type LoginChallengeResponse = LoginResult;

export type LoginChallengeResult = {
  "challengeId": string;
};

export type LoginRequest = {
  "userName": string;
  "password": string;
  "rememberMe"?: boolean;
};

export type LoginResponse = LoginResult | LoginChallengeResult;

export type LoginResult = {
  "accessToken": string;
  "refreshToken": string;
  "expiresIn": number;
  "userId": string;
  "portalId": string | null;
  "role": string[];
  "type": string;
  "csrfToken": string;
};

export type LogoutRequest = {
  "refreshToken"?: string;
};

export type LogoutResponse = {
  "status": boolean;
};

export type PrincipalProfile = {
  "id": string;
  "userName": string;
  "type": string;
  "roles": string[];
  "teams": string[];
  "locale": string | null;
  "timezone": string | null;
  "mfaPending": boolean;
  "sessionId": string | null;
  "firstName"?: string | null;
  "lastName"?: string | null;
  "emailAddress"?: string | null;
  "phoneNumber"?: string | null;
  "title"?: string | null;
  "avatarId"?: string | null;
};

export type RefreshRequest = {
  "refreshToken"?: string;
};

export type RefreshResponse = LoginResult;

export interface CaroCrmApiOperations {
  readonly authenticationLogin: (body: LoginRequest) => Promise<LoginResponse>;
  readonly authenticationChallenge: (body: LoginChallengeRequest) => Promise<LoginChallengeResponse>;
  readonly sessionRefresh: (body?: RefreshRequest) => Promise<RefreshResponse>;
  readonly sessionLogout: (body?: LogoutRequest) => Promise<LogoutResponse>;
  readonly sessionMe: () => Promise<PrincipalProfile>;
}

export const API_OPERATIONS = [
  { operationId: "authentication.login", method: "POST", path: "/api/v1/Authentication", requestType: "LoginRequest", responseType: "LoginResponse", auth: "public" },
  { operationId: "authentication.challenge", method: "POST", path: "/api/v1/Authentication/challenge", requestType: "LoginChallengeRequest", responseType: "LoginChallengeResponse", auth: "public" },
  { operationId: "session.refresh", method: "POST", path: "/api/v1/Refresh", requestType: "RefreshRequest", responseType: "RefreshResponse", auth: "cookie+csrf" },
  { operationId: "session.logout", method: "POST", path: "/api/v1/Logout", requestType: "LogoutRequest", responseType: "LogoutResponse", auth: "authenticated" },
  { operationId: "session.me", method: "GET", path: "/api/v1/AppUser/me", requestType: null, responseType: "PrincipalProfile", auth: "authenticated" },
] as const;

export type ApiOperationId = (typeof API_OPERATIONS)[number]['operationId'];

export function createApiClient(transport: ApiTransport): CaroCrmApiOperations {
  return {
    authenticationLogin: (body: LoginRequest) => transport.request<LoginResponse>({ method: "POST", path: "/api/v1/Authentication", body }),
    authenticationChallenge: (body: LoginChallengeRequest) => transport.request<LoginChallengeResponse>({ method: "POST", path: "/api/v1/Authentication/challenge", body }),
    sessionRefresh: (body?: RefreshRequest) => transport.request<RefreshResponse>({ method: "POST", path: "/api/v1/Refresh", body }),
    sessionLogout: (body?: LogoutRequest) => transport.request<LogoutResponse>({ method: "POST", path: "/api/v1/Logout", body }),
    sessionMe: () => transport.request<PrincipalProfile>({ method: "GET", path: "/api/v1/AppUser/me" }),
  };
}
