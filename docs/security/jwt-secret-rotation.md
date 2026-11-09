# JWT secret rotation procedure (Phase 23.1, task 4)

## Scope
`JWT_SECRET` (HS256 signing key for access/refresh tokens). Rotation is a platform operation; it invalidates
every outstanding access and refresh token issued under the previous secret.

## Preconditions
- A maintenance window or a willingness to force all users to re-authenticate.
- Access to the deployment environment and its secret store.
- A new strong secret: `openssl rand -hex 32` (or longer). Never reuse the development default
  `dev-only-secret-change-me`.

## Procedure
1. Generate the new secret and store it in the secret manager / deployment configuration (`JWT_SECRET`).
   Do **not** commit it to version control or print it in logs.
2. Set `NODE_ENV=production` (it already is in production deployments) so the boot guard
   (`config.ts` `ConfigSchemaRefined`) accepts only a non-default secret.
3. Deploy / restart the API and worker. The boot guard rejects an empty or default secret.
4. On boot, all previously issued access tokens (HS256, `typ=access`) fail signature verification and
   all refresh tokens are rejected, so every session is forced to re-authenticate.
5. Verify login, refresh, and logout end-to-end after rotation.
6. Record the rotation in the audit log / change record (who, when, reason). Do not record the secret value.

## Rollback
Rotating back to the previous secret within its lifetime is **not** supported once users have
re-authenticated under the new secret (their new refresh tokens are bound to the new secret).
Keep the previous secret available in the secret manager only for the duration of the window, then
destroy it.

## Notes
- There is no separate CSRF secret; CSRF is a double-submit comparison bound to the session cookie.
- Rotation does not affect API-key secrets, which are hashed per key and rotated individually.