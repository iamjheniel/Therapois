import { Page, APIRequestContext, expect } from '@playwright/test';

/**
 * The auth-token security pass on the WEB target (RC 3.12 #3460 SEC-01.4 + #3463 SEC-04).
 *
 * #3460 cuts the access-token TTL to one hour and makes the client refresh transparently on a 401
 * instead of logging the user out; #3463 moves token material out of plaintext device storage. Both
 * ship on two platforms and this suite only drives one of them — so what is decidable here is the
 * WEB half, which `packages/auth/README.md` defines explicitly:
 *
 * | platform | access token | refresh token |
 * |---|---|---|
 * | native | `expo-secure-store` (Keychain/Keystore) | `expo-secure-store` |
 * | **web** | **in memory**, re-obtained via refresh on boot | `localStorage` key `auth-refresh-token` (documented accepted risk, review 2026-11-30) |
 *
 * That matrix is why the web client calls `POST /token/refresh` once on every boot: it has no
 * persisted access token to start from. It is also why `.auth/*.json` is single-use for this suite
 * — the refresh token rotates on every use.
 *
 * **Reuse revokes the whole family.** Replaying a spent refresh token does not merely fail; it
 * invalidates the live descendant too. Any test that replays an old token has therefore destroyed
 * the session it was holding, and must re-login rather than continue.
 */

export const API = 'https://api.staging.therapios.de';
export const APP = 'https://staging.therapios.de';
/** The AsyncStorage/localStorage key the whole auth state persists under. */
export const AUTH_KEY = 'auth-state';
export const REFRESH_KEY = 'auth-refresh-token';
export const LEGACY_ACCESS_KEY = 'auth-legacy-access-token';
export const MIGRATION_FLAG = '_auth_token_migration_done';

export type TokenPair = { token: string; refresh_token: string };

export class AuthRefreshPage {
  static readonly API = API;

  constructor(private request: APIRequestContext) {}

  private async post(path: string, data: unknown): Promise<{ status: number; body: any }> {
    const response = await this.request.post(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      data,
      timeout: 120_000,
      failOnStatusCode: false,
    });
    let body: any = null;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = null;
    }
    return { status: response.status(), body };
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const result = await this.post('/auth', { username: email, password });
    expect(result.status, 'POST /auth').toBe(200);
    return result.body;
  }

  async refresh(refreshToken: string): Promise<{ status: number; body: any }> {
    return this.post('/token/refresh', { refresh_token: refreshToken });
  }

  /** `exp - iat` on the access token — the TTL the server actually issues, whatever the yaml says. */
  static ttlSeconds(accessToken: string): number {
    const claims = AuthRefreshPage.claims(accessToken);
    return claims.exp - claims.iat;
  }

  static claims(accessToken: string): { iat: number; exp: number; username?: string } {
    return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
  }

  /** What the browser actually persists — #3463 AC3 is explicit that this must be inspected. */
  static async storedAuth(page: Page): Promise<{
    authState: any;
    refreshToken: string | null;
    legacyAccess: string | null;
    migrationFlag: string | null;
    keys: string[];
  }> {
    return page.evaluate(
      ({ authKey, refreshKey, legacyKey, flagKey }) => {
        const raw = localStorage.getItem(authKey);
        let parsed: any = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        return {
          authState: parsed,
          refreshToken: localStorage.getItem(refreshKey),
          legacyAccess: localStorage.getItem(legacyKey),
          migrationFlag: localStorage.getItem(flagKey),
          keys: Object.keys(localStorage),
        };
      },
      { authKey: AUTH_KEY, refreshKey: REFRESH_KEY, legacyKey: LEGACY_ACCESS_KEY, flagKey: MIGRATION_FLAG },
    );
  }

  /** Anything that looks like a JWT anywhere in a persisted value. */
  static containsJwt(value: unknown): boolean {
    return /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/.test(JSON.stringify(value ?? null));
  }
}
