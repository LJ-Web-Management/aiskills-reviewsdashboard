import { config } from './config.js';
import { db, getSetting, setSetting } from './db.js';
import { AppError, encrypt, decrypt } from './security.js';
import { brand } from './brand.js';

// USD per 1M tokens. Estimates only; edit them in Settings to match https://openai.com/api/pricing
export const DEFAULT_PRICING = {
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
};

export const TONES = {
  friendly: 'Friendly and upbeat, like a helpful owner talking to a regular.',
  professional: 'Professional and polished, courteous without being stiff.',
  warm: 'Warm and heartfelt, genuinely appreciative.',
  concise: 'Brief and to the point, still polite.',
  playful: 'Light and playful with a touch of humour (but serious and sincere for complaints).',
};

export const LENGTHS = {
  short: '1 to 2 sentences (under 50 words)',
  medium: '2 to 4 sentences (under 90 words)',
  long: 'one short paragraph (under 140 words)',
};

const DEFAULTS = {
  businessName: brand.businessName || '',
  tone: 'friendly',
  replyLength: 'medium',
  signature: '',
  customInstructions: '',
  autoDraft: true,
  autoApprove: { enabled: false, stars: [5] },
  syncIntervalMinutes: 15,
  openaiModel: config.openaiModel,
  pricing: {},
};

export function getAppSettings() {
  const saved = getSetting('app', {});
  return {
    ...DEFAULTS,
    ...saved,
    autoApprove: { ...DEFAULTS.autoApprove, ...(saved.autoApprove || {}) },
    pricing: { ...DEFAULTS.pricing, ...(saved.pricing || {}) },
  };
}

function str(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function price(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) throw new AppError('Prices must be numbers between 0 and 10,000.');
  return Math.round(n * 1e6) / 1e6;
}

export function updateAppSettings(input) {
  const current = getAppSettings();
  const next = { ...current };
  if ('businessName' in input) next.businessName = str(input.businessName, 120);
  if ('tone' in input) {
    if (!TONES[input.tone]) throw new AppError('Unknown tone.');
    next.tone = input.tone;
  }
  if ('replyLength' in input) {
    if (!LENGTHS[input.replyLength]) throw new AppError('Unknown reply length.');
    next.replyLength = input.replyLength;
  }
  if ('signature' in input) next.signature = str(input.signature, 120);
  if ('customInstructions' in input) next.customInstructions = str(input.customInstructions, 2000);
  if ('autoDraft' in input) next.autoDraft = !!input.autoDraft;
  if ('autoApprove' in input) {
    const a = input.autoApprove || {};
    const stars = [...new Set((Array.isArray(a.stars) ? a.stars : []).map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 5)
      .sort((x, y) => y - x);
    next.autoApprove = { enabled: !!a.enabled && stars.length > 0, stars };
  }
  if ('syncIntervalMinutes' in input) {
    const n = Math.round(Number(input.syncIntervalMinutes));
    if (!Number.isFinite(n) || n < 5 || n > 1440) throw new AppError('Sync interval must be between 5 and 1440 minutes.');
    next.syncIntervalMinutes = n;
  }
  if ('openaiModel' in input) {
    const m = str(input.openaiModel, 80);
    if (!/^[A-Za-z0-9._:-]+$/.test(m)) throw new AppError('Model name can only contain letters, numbers, dots, dashes and colons.');
    next.openaiModel = m;
  }
  if (input.modelPricing && typeof input.modelPricing === 'object') {
    const p = input.modelPricing;
    next.pricing = {
      ...next.pricing,
      [next.openaiModel]: { input: price(p.input), cachedInput: price(p.cachedInput ?? p.input), output: price(p.output) },
    };
  }
  setSetting('app', next);
  return next;
}

/** Price for a model: saved override, else built-in default (longest matching prefix), else null. */
export function getModelPricing(model, settings = getAppSettings()) {
  if (settings.pricing[model]) return settings.pricing[model];
  if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model];
  const prefix = Object.keys(DEFAULT_PRICING)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? DEFAULT_PRICING[prefix] : null;
}

// ---------- OpenAI key (env var wins; otherwise the encrypted key saved from the UI) ----------

export function getOpenAIKey() {
  if (config.openaiApiKey) return config.openaiApiKey;
  const enc = getSetting('openaiKeyEnc');
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    return null;
  }
}

export function openAIKeyStatus() {
  const key = getOpenAIKey();
  if (!key) return { configured: false, source: null, hint: null };
  return { configured: true, source: config.openaiApiKey ? 'env' : 'saved', hint: `…${key.slice(-4)}` };
}

export function saveOpenAIKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!/^sk-[A-Za-z0-9_\-]{16,300}$/.test(key)) throw new AppError('That does not look like an OpenAI API key (it should start with "sk-").');
  setSetting('openaiKeyEnc', encrypt(key));
}

export function clearOpenAIKey() {
  setSetting('openaiKeyEnc', null);
}

// ---------- Google connection ----------

export function getGoogleConnection() {
  return getSetting('google', null);
}

export function setGoogleConnection(value) {
  setSetting('google', value);
}

export function isDemoMode() {
  const g = getGoogleConnection();
  return config.demoMode && !(g && g.locationName);
}

export function countAutoApproveMatches(settings = getAppSettings()) {
  if (!settings.autoApprove.stars.length) return 0;
  const marks = settings.autoApprove.stars.map(() => '?').join(',');
  return db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending' AND star_rating IN (${marks})`)
    .get(...settings.autoApprove.stars).n;
}
