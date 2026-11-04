import { config } from './config.js';
import { AppError, encrypt, decrypt } from './security.js';
import { getGoogleConnection, setGoogleConnection } from './settings.js';

const SCOPES = ['https://www.googleapis.com/auth/business.manage', 'openid', 'email'];
const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export function isGoogleConfigured() {
  return !!(config.googleClientId && config.googleClientSecret);
}

export function redirectUri() {
  return `${config.appUrl}/api/google/callback`;
}

export function authUrl(state) {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new AppError(`Google sign-in failed: ${data.error_description || data.error || res.status}`, 502);
    err.googleError = data.error;
    throw err;
  }
  return data;
}

let accessCache = { token: null, expiresAt: 0 };

export async function exchangeCode(code) {
  const data = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!data.refresh_token) throw new AppError('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.', 502);
  let email = null;
  if (data.id_token) {
    // The ID token came straight from Google's token endpoint over TLS, so its payload can be read without re-verifying.
    try { email = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString()).email || null; } catch { /* ignore */ }
  }
  accessCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return { refreshTokenEnc: encrypt(data.refresh_token), email };
}

async function accessToken() {
  if (accessCache.token && accessCache.expiresAt > Date.now()) return accessCache.token;
  const conn = getGoogleConnection();
  if (!conn?.refreshTokenEnc) throw new AppError('Google is not connected.', 400);
  try {
    const data = await tokenRequest({ refresh_token: decrypt(conn.refreshTokenEnc), grant_type: 'refresh_token' });
    accessCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return accessCache.token;
  } catch (err) {
    if (err.googleError === 'invalid_grant') {
      setGoogleConnection({ ...conn, needsReconnect: true });
      throw new AppError('Google access was revoked or expired. Reconnect Google in Settings.', 400);
    }
    throw err;
  }
}

async function gapi(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new AppError(`Google API: ${msg}`, res.status === 404 ? 404 : 502);
  }
  return data;
}

export function clearAccessToken() {
  accessCache = { token: null, expiresAt: 0 };
}

export async function revoke() {
  const conn = getGoogleConnection();
  clearAccessToken();
  if (!conn?.refreshTokenEnc) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(conn.refreshTokenEnc))}`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
    });
  } catch { /* best effort */ }
}

/** All locations the connected Google account manages. */
export async function listLocations() {
  const accounts = [];
  let pageToken = '';
  do {
    const data = await gapi(`https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20${pageToken ? `&pageToken=${pageToken}` : ''}`);
    accounts.push(...(data.accounts || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  const locations = [];
  for (const acct of accounts) {
    let token = '';
    do {
      const qs = new URLSearchParams({ readMask: 'name,title,storefrontAddress', pageSize: '100', ...(token ? { pageToken: token } : {}) });
      const data = await gapi(`https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?${qs}`);
      for (const loc of data.locations || []) {
        const addr = loc.storefrontAddress;
        locations.push({
          accountName: acct.name,
          accountTitle: acct.accountName || '',
          locationName: loc.name,
          title: loc.title || loc.name,
          address: addr ? [...(addr.addressLines || []), addr.locality].filter(Boolean).join(', ') : '',
        });
      }
      token = data.nextPageToken || '';
    } while (token);
  }
  return locations;
}

function toMs(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * Fetch reviews newest-updated first. Stops once it reaches reviews not updated since `sinceMs`.
 */
export async function fetchReviews(accountName, locationName, { sinceMs = 0, maxPages = 20 } = {}) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc', ...(pageToken ? { pageToken } : {}) });
    const data = await gapi(`https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/reviews?${qs}`);
    let reachedOld = false;
    for (const r of data.reviews || []) {
      const updated = toMs(r.updateTime) || toMs(r.createTime);
      if (sinceMs && updated && updated <= sinceMs) { reachedOld = true; break; }
      out.push({
        externalId: r.name,
        reviewerName: r.reviewer?.isAnonymous ? 'A Google User' : (r.reviewer?.displayName || 'A Google User'),
        reviewerPhoto: r.reviewer?.profilePhotoUrl || null,
        starRating: STAR[r.starRating] || null,
        comment: r.comment || '',
        createdAt: toMs(r.createTime) || Date.now(),
        updatedAt: updated,
        reply: r.reviewReply?.comment ? { text: r.reviewReply.comment, at: toMs(r.reviewReply.updateTime) } : null,
      });
    }
    pageToken = data.nextPageToken || '';
    if (reachedOld || !pageToken) break;
  }
  return out;
}

export async function postReply(reviewName, comment) {
  if (!/^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/.test(reviewName)) throw new AppError('Invalid review id.');
  return gapi(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, { method: 'PUT', body: { comment } });
}
