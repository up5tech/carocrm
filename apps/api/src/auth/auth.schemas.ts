import { z } from 'zod';

/**
 * Phase 24.4 — the sign-in request schemas, exported so the api-spec contract test can prove the
 * JSON Schema documents under `api-spec/schemas/` accept and reject exactly what these accept and
 * reject. Keep in sync with `api-spec/schemas/authentication.*.v1.json`.
 */
export const LoginSchema = z.object({
  userName: z.string().min(1),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const LogoutSchema = z.object({
  refreshToken: z.string().optional(),
});

/** §4.9: the second factor that finishes a sign-in the password started. */
export const ChallengeSchema = z.object({
  challengeId: z.string().min(1).max(64),
  code: z.string().min(4).max(64),
});
