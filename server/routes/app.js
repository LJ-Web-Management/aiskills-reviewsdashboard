import express from 'express';
import { db, audit, getSetting } from '../db.js';
import { config } from '../config.js';
import { AppError, randomToken, safeEqual } from '../security.js';
import { generateReply } from '../openai.js';
import { getAnalytics } from '../analytics.js';
import { runSync } from '../reviews.js';
import { clearDemoData } from '../demo.js';
import * as google from '../google.js';
import {
  getAppSettings, updateAppSettings, getModelPricing, DEFAULT_PRICING, TONES, LENGTHS,
  openAIKeyStatus, saveOpenAIKey, clearOpenAIKey, getGoogleConnection, setGoogleConnection,
  isDemoMode,
} from '../settings.js';

const router = express.Router();

function googleStatus() {
  const g = getGoogleConnection();
  return {
    configured: google.isGoogleConfigured(),
    connected: !!g?.refreshTokenEnc,
    needsReconnect: !!g?.needsReconnect,
    email: g?.email || null,
    locationName: g?.locationName || null,
    locationTitle: g?.locationTitle || null,
    redirectUri: google.redirectUri(),
  };
}

router.get('/status', (req, res) => {
  const s = getAppSettings();
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE status IN ('pending', 'failed')`).get().n;
  res.json({
    demoMode: isDemoMode(),
    businessName: s.businessName,
    google: googleStatus(),
    openai: { ...openAIKeyStatus(), model: s.openaiModel },
    autoApprove: s.autoApprove,
    pendingCount: pending,
    lastSync: getSetting('lastSync', null),
  });
});

// ---------- Settings ----------

function settingsPayload() {
  const s = getAppSettings();
  return {
    settings: {
      businessName: s.businessName,
      tone: s.tone,
      replyLength: s.replyLength,
      signature: s.signature,
      customInstructions: s.customInstructions,
      autoDraft: s.autoDraft,
      autoApprove: s.autoApprove,
      syncIntervalMinutes: s.syncIntervalMinutes,
      openaiModel: s.openaiModel,
      modelPricing: getModelPricing(s.openaiModel, s),
    },
    options: {
      tones: Object.keys(TONES),
      lengths: Object.keys(LENGTHS),
      models: Object.keys(DEFAULT_PRICING),
      defaultPricing: DEFAULT_PRICING,
      savedPricing: s.pricing,
    },
    openai: openAIKeyStatus(),
    google: googleStatus(),
    pendingByStars: Object.fromEntries(
      db.prepare(`SELECT star_rating AS stars, COUNT(*) AS n FROM reviews WHERE status = 'pending' GROUP BY star_rating`).all().map((r) => [r.stars, r.n]),
    ),
  };
}

router.get('/settings', (req, res) => res.json(settingsPayload()));

router.put('/settings', (req, res) => {
  const before = getAppSettings();
  const after = updateAppSettings(req.body || {});
  const changed = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changed.length) audit(req.user, 'settings_changed', changed.join(', '));
  if (JSON.stringify(before.autoApprove) !== JSON.stringify(after.autoApprove)) {
    audit(req.user, 'auto_approve_changed', after.autoApprove.enabled ? `on for ${after.autoApprove.stars.join(', ')}★` : 'off');
  }
  res.json(settingsPayload());
});

router.put('/settings/openai-key', (req, res) => {
  if (config.openaiApiKey) throw new AppError('The key is set by the OPENAI_API_KEY environment variable. Change it there.');
  saveOpenAIKey(req.body?.apiKey);
  audit(req.user, 'openai_key_saved');
  res.json(settingsPayload());
});

router.delete('/settings/openai-key', (req, res) => {
  clearOpenAIKey();
  audit(req.user, 'openai_key_removed');
  res.json(settingsPayload());
});

// Try the current (possibly unsaved) style settings on a sample review.
router.post('/settings/preview', async (req, res) => {
  const b = req.body || {};
  const stars = Math.min(Math.max(parseInt(b.stars, 10) || 5, 1), 5);
  const overrides = {};
  for (const k of ['businessName', 'tone', 'replyLength', 'signature', 'customInstructions', 'openaiModel']) {
    if (typeof b[k] === 'string') overrides[k] = b[k].slice(0, k === 'customInstructions' ? 2000 : 120);
  }
  if (overrides.tone && !TONES[overrides.tone]) delete overrides.tone;
  if (overrides.replyLength && !LENGTHS[overrides.replyLength]) delete overrides.replyLength;
  if (overrides.openaiModel && !/^[A-Za-z0-9._:-]+$/.test(overrides.openaiModel)) delete overrides.openaiModel;
  const reply = await generateReply(
    { reviewer_name: String(b.reviewerName || 'Alex Morgan').slice(0, 80), star_rating: stars, comment: String(b.comment || '').slice(0, 2000) },
    { purpose: 'preview', overrides },
  );
  res.json({ reply });
});

// ---------- Google Business Profile ----------

router.get('/google/connect', (req, res) => {
  if (!google.isGoogleConfigured()) throw new AppError('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see README).');
  const state = randomToken(24);
  db.prepare('UPDATE sessions SET oauth_state = ? WHERE token_hash = ?').run(state, req._session.token_hash);
  res.redirect(google.authUrl(state));
});

router.get('/google/callback', async (req, res) => {
  const expected = req._session.oauth_state;
  db.prepare('UPDATE sessions SET oauth_state = NULL WHERE token_hash = ?').run(req._session.token_hash);
  const state = String(req.query.state || '');
  if (!expected || !safeEqual(state, expected)) return res.redirect('/#settings?google=state_error');
  if (req.query.error || !req.query.code) return res.redirect('/#settings?google=denied');
  try {
    const { refreshTokenEnc, email } = await google.exchangeCode(String(req.query.code));
    const prev = getGoogleConnection() || {};
    setGoogleConnection({
      refreshTokenEnc, email, connectedAt: Date.now(),
      // Keep the chosen location if the same account reconnects.
      ...(prev.email === email ? { accountName: prev.accountName, locationName: prev.locationName, locationTitle: prev.locationTitle, watermark: prev.watermark } : {}),
    });
    audit(req.user, 'google_connected', email);
    res.redirect('/#settings?google=connected');
  } catch (err) {
    console.error('[google] OAuth callback failed:', err.message);
    res.redirect('/#settings?google=error');
  }
});

router.get('/google/locations', async (req, res) => {
  if (!getGoogleConnection()?.refreshTokenEnc) throw new AppError('Connect Google first.');
  res.json({ locations: await google.listLocations() });
});

router.post('/google/location', async (req, res) => {
  const conn = getGoogleConnection();
  if (!conn?.refreshTokenEnc) throw new AppError('Connect Google first.');
  const { accountName, locationName } = req.body || {};
  // Only accept a location the connected account actually manages.
  const match = (await google.listLocations()).find((l) => l.accountName === accountName && l.locationName === locationName);
  if (!match) throw new AppError('That location is not available on the connected Google account.');
  const switching = conn.locationName && conn.locationName !== match.locationName;
  if (switching) db.prepare("DELETE FROM reviews WHERE source = 'google'").run();
  setGoogleConnection({ ...conn, accountName: match.accountName, locationName: match.locationName, locationTitle: match.title, watermark: switching ? 0 : conn.watermark || 0 });
  clearDemoData();
  audit(req.user, 'google_location_selected', match.title);
  const summary = await runSync({ manual: true, user: req.user });
  res.json({ google: googleStatus(), summary });
});

router.post('/google/disconnect', async (req, res) => {
  await google.revoke();
  setGoogleConnection(null);
  audit(req.user, 'google_disconnected');
  res.json({ google: googleStatus() });
});

// ---------- Analytics ----------

router.get('/analytics', (req, res) => {
  res.json(getAnalytics({ range: String(req.query.range || '30'), tzOffset: req.query.tz }));
});

export default router;
