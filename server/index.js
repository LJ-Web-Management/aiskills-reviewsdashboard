import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config, ROOT } from './config.js';
import { db, cleanup } from './db.js';
import { loadSession, requireAuth, csrfProtect, originCheck, ensureInitialAdmin } from './auth.js';
import { isDemoMode } from './settings.js';
import { seedDemoData } from './demo.js';
import { startScheduler } from './reviews.js';
import authRoutes from './routes/auth.js';
import reviewRoutes from './routes/reviews.js';
import appRoutes from './routes/app.js';

const app = express();
const PUBLIC = path.join(ROOT, 'public');

app.disable('x-powered-by');
if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      ...(config.secureCookies ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  hsts: config.secureCookies ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'same-origin' },
}));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(originCheck);

// Static assets (CSS/JS/icons) are public; the pages and all data are behind login.
app.use('/assets', express.static(path.join(PUBLIC, 'assets'), { maxAge: config.isProd ? '1h' : 0, index: false }));

app.get('/login', (req, res) => {
  if (loadSession(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC, 'login.html'));
});

app.get('/', (req, res) => {
  if (!loadSession(req)) return res.redirect('/login');
  res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC, 'app.html'));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Slow down a little.' } });
app.use('/api', apiLimiter, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', authRoutes); // login is public; the rest of this router requires auth
app.use('/api', requireAuth, csrfProtect, reviewRoutes, appRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.redirect('/'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (err.isAppError) return res.status(err.status).json({ error: err.message, ...err.extra });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

await ensureInitialAdmin();
if (isDemoMode() && seedDemoData()) console.log('[demo] Loaded sample reviews. They disappear once a Google location is connected.');
cleanup();
setInterval(cleanup, 3_600_000).unref();
startScheduler();

const server = app.listen(config.port, config.host, () => {
  console.log(`Review Reply Admin running at ${config.appUrl} (listening on ${config.host}:${config.port})`);
  if (!config.secureCookies && config.isProd) console.warn('[security] APP_URL is not https. Serve this app over HTTPS in production.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
