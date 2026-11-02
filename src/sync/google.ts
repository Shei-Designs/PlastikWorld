// Signing in to Google and keeping the tokens. PlastikCAD's
// `src/sync/google.ts`, lifted. On desktop the app is an "installed app" to
// Google: the sign-in page opens in the system browser and comes back, with
// PKCE, to a loopback port (see the Rust side); the token exchange and
// refreshes are plain HTTPS requests from here. On Android, Google takes no
// redirect URL, so Google Play services asks for the grant and hands back
// access tokens, one at a time, with no refresh token: a new one is fetched
// when the old runs out. The clients come from the build environment:
// VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_CLIENT_SECRET for a Google "Desktop
// app" client (for an installed app Google does not treat the secret as
// secret), and VITE_GOOGLE_ANDROID_CLIENT_ID for an "Android" client, which
// Play services finds by the app's package and signing key; the id itself
// only says that the Android build is set up.
import * as platform from '../platform';

const env = (name: string): string => (import.meta.env[name] as string | undefined) ?? '';

export const GOOGLE_CLIENT = platform.isAndroid()
  ? { id: env('VITE_GOOGLE_ANDROID_CLIENT_ID'), secret: '' }
  : { id: env('VITE_GOOGLE_CLIENT_ID'), secret: env('VITE_GOOGLE_CLIENT_SECRET') };

/** The app may see and change only the files it made itself; nothing else in the Drive. */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const TOKENS_KEY = 'plastikworld:google:v1';

export interface Tokens {
  access: string;
  refresh: string;
  /** When the access token runs out, ms since the epoch. */
  expires: number;
  /** Who signed in, once known. */
  email: string | null;
}

export const isConfigured = (): boolean => GOOGLE_CLIENT.id.length > 0;

export function loadTokens(): Tokens | null {
  try {
    const raw = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? 'null') as Partial<Tokens> | null;
    if (!raw || typeof raw.access !== 'string' || typeof raw.refresh !== 'string' || typeof raw.expires !== 'number') return null;
    return { access: raw.access, refresh: raw.refresh, expires: raw.expires, email: typeof raw.email === 'string' ? raw.email : null };
  } catch {
    return null;
  }
}

export function saveTokens(tokens: Tokens | null): void {
  try {
    if (tokens) localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(TOKENS_KEY);
  } catch {
    // Without storage the sign-in lasts for the session.
  }
}

/** Android: Play services' tokens are good for an hour; this is when one is given up for a fresh one. */
const ANDROID_TOKEN_MS = 50 * 60_000;

/** Thrown when the account has to be linked again (the refresh token was revoked, or there never was one). */
export class NeedsSignIn extends Error {
  constructor(message = 'Sign in to Google Drive again.') {
    super(message);
  }
}

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE: the S256 challenge of a verifier. */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authUrl(redirect: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT.id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // A refresh token is only issued with offline access, and only reliably when consent is asked again.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({ client_id: GOOGLE_CLIENT.id, ...fields });
  if (GOOGLE_CLIENT.secret) body.set('client_secret', GOOGLE_CLIENT.secret);
  const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !json.access_token) {
    if (json.error === 'invalid_grant') throw new NeedsSignIn();
    throw new Error(json.error_description || json.error || `Google answered ${response.status}`);
  }
  return json;
}

/** The sign-in under way, for `cancelSignIn`. */
let pending: platform.SignInSession | null = null;

/** Android: a token from Play services, with the errors it names put into words. */
async function androidTokens(silent: boolean): Promise<Tokens> {
  let access: string;
  try {
    access = await platform.androidAuthorize(SCOPE, silent);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'needs-sign-in') throw new NeedsSignIn();
    if (message === 'cancelled') throw new Error('The sign-in was cancelled.');
    throw new Error(message);
  }
  return { access, refresh: '', expires: Date.now() + ANDROID_TOKEN_MS, email: null };
}

/** Walks the user through the sign-in (the browser on desktop, Google's sheet on Android) and returns the tokens. */
export async function signIn(): Promise<Tokens> {
  if (!isConfigured()) throw new Error('Google Drive sync is not set up in this build.');
  if (platform.isAndroid()) return androidTokens(false);
  const verifier = randomToken(48);
  const state = randomToken(16);
  const session = await platform.oauthStart();
  pending = session;
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(await platform.oauthWait(session, authUrl(session.redirect, await challengeOf(verifier), state)));
  } finally {
    pending = null;
  }
  const redirect = session.redirect;
  if (query.get('error')) throw new Error(query.get('error') === 'access_denied' ? 'The sign-in was cancelled.' : `Google refused the sign-in: ${query.get('error')}`);
  if (query.get('state') !== state || !query.get('code')) throw new Error('The sign-in did not come back as expected. Try again.');
  const json = await tokenRequest({ grant_type: 'authorization_code', code: query.get('code')!, code_verifier: verifier, redirect_uri: redirect });
  if (!json.refresh_token) throw new NeedsSignIn('Google gave no lasting access. Try signing in again.');
  return { access: json.access_token!, refresh: json.refresh_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000, email: null };
}

/** Gives up the sign-in under way, if any; `signIn` then rejects. */
export function cancelSignIn(): void {
  if (pending) void platform.oauthCancel(pending);
}

/** Tells Google the grant is over, so that it no longer shows among the account's connected apps. Failing that is no reason to stay linked. */
export async function revoke(tokens: Tokens): Promise<boolean> {
  try {
    // Revoking an access token revokes the grant behind it too, which is all Android has.
    const response = await fetch(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh || tokens.access }) });
    if (platform.isAndroid()) await platform.androidClearToken(tokens.access);
    return response.ok;
  } catch {
    return false;
  }
}

export async function refresh(tokens: Tokens): Promise<Tokens> {
  // Android keeps no refresh token: the next one comes from Play services, without a word if the grant stands.
  if (platform.isAndroid()) return { ...(await androidTokens(true)), email: tokens.email };
  const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
  return { ...tokens, access: json.access_token!, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
}

/**
 * `fetch` with the account's access token, refreshed when it is about to run
 * out or Google turns it down. `tokens` is read and updated through the
 * callbacks so that a refresh is kept.
 */
export function authorizedFetch(get: () => Tokens | null, set: (tokens: Tokens) => void): (url: string, init?: RequestInit) => Promise<Response> {
  let refreshing: Promise<Tokens> | null = null;
  const fresh = async (force: boolean): Promise<Tokens> => {
    const current = get();
    if (!current) throw new NeedsSignIn();
    if (!force && current.expires - Date.now() > 60_000) return current;
    refreshing ??= refresh(current)
      .then((next) => {
        set(next);
        return next;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };
  return async (url, init = {}) => {
    const send = (tokens: Tokens) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${tokens.access}` } });
    let response = await send(await fresh(false));
    if (response.status === 401) response = await send(await fresh(true));
    return response;
  };
}
