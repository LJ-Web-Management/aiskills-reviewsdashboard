// Branding lives in the /brand folder so each deployment can have its own name, logo, colours and demo data
// without touching the code:
//   brand/brand.json   name, logo files, default business name
//   brand/theme.css    colour / font overrides (optional)
//   brand/demo.json    sample reviews shown in demo mode (optional)
//   brand/*.png|svg|ico|webp|woff2   logo, favicon and font files
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const BRAND_DIR = path.join(ROOT, 'brand');

const DEFAULTS = {
  name: 'Review Replies', // shown in titles and alt text
  appName: 'Review Replies', // the product label shown next to / under the logo
  businessName: '', // default "Business name" used in AI replies (editable in Settings)
  website: '',
  logo: null, // logo for light backgrounds, relative to /brand
  logoDark: null, // optional logo for dark mode
  favicon: null,
  appleTouchIcon: null,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(BRAND_DIR, file), 'utf8'));
  } catch {
    return null;
  }
}

export const brand = Object.freeze({ ...DEFAULTS, ...(readJson('brand.json') || {}) });
export const brandDemo = readJson('demo.json');
const hasTheme = fs.existsSync(path.join(BRAND_DIR, 'theme.css'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const asset = (file) => `/brand/${encodeURIComponent(file)}`;

const DEFAULT_MARK = '<div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H11l-4 3v-3H4z"/><path d="m12 7.6.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill="#fff" stroke="none"/></svg></div>';

function logoHtml() {
  if (!brand.logo) return `<div class="brand">${DEFAULT_MARK}<span class="brand-name">${esc(brand.appName)}</span></div>`;
  const dark = brand.logoDark ? `<source srcset="${asset(brand.logoDark)}" media="(prefers-color-scheme: dark)">` : '';
  const sub = brand.appName && brand.appName !== brand.name ? `<span class="brand-sub">${esc(brand.appName)}</span>` : '';
  return `<div class="brand brand-custom"><picture>${dark}<img class="brand-logo" src="${asset(brand.logo)}" alt="${esc(brand.name)}"></picture>${sub}</div>`;
}

function headHtml() {
  const icons = brand.favicon
    ? `<link rel="icon" href="${asset(brand.favicon)}">`
    : '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">';
  const touch = brand.appleTouchIcon ? `<link rel="apple-touch-icon" href="${asset(brand.appleTouchIcon)}">` : '';
  const theme = hasTheme ? '<link rel="stylesheet" href="/brand/theme.css">' : '';
  return `${icons}${touch}<link rel="stylesheet" href="/assets/app.css">${theme}`;
}

const cache = new Map();

/** Fill the {{...}} placeholders in an HTML page with this deployment's branding. */
export function renderPage(file) {
  if (cache.has(file)) return cache.get(file);
  const title = brand.name === brand.appName ? brand.appName : `${brand.name} ${brand.appName}`;
  const html = fs.readFileSync(file, 'utf8')
    .replaceAll('{{HEAD}}', headHtml())
    .replaceAll('{{LOGO}}', logoHtml())
    .replaceAll('{{TITLE}}', esc(title))
    .replaceAll('{{BRAND_NAME}}', esc(brand.name))
    .replaceAll('{{APP_NAME}}', esc(brand.appName))
    .replaceAll('{{BUSINESS_NAME}}', esc(brand.businessName || brand.name));
  cache.set(file, html);
  return html;
}

const SERVABLE = /^[\w.-]+\.(png|svg|webp|ico|jpe?g|css|woff2?)$/i;

/** Serve only asset files from /brand (never the JSON config). */
export function brandAssets(req, res, next) {
  const name = req.path.replace(/^\/+/, '');
  if (!SERVABLE.test(name)) return res.status(404).end();
  res.sendFile(path.join(BRAND_DIR, name), { maxAge: '1h', dotfiles: 'deny' }, (err) => {
    if (err) res.status(404).end();
  });
}
