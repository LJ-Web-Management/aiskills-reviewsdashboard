# Review Replies — Google review auto-reply dashboard

A secure admin panel that pulls your Google reviews, drafts a reply to each one with OpenAI, and posts the reply to Google once you approve it, or automatically for the star ratings you choose.

- **Reviews dashboard**: reviewer name, star rating, review text and an editable AI-drafted reply. Approve & post, regenerate, or skip.
- **Auto-approve**: pick which ratings (e.g. 4★ and 5★) get replied to automatically. Everything else waits for a person.
- **Analytics**: review volume, rating distribution, average rating over time, response rate, median time to reply, and how replies were handled.
- **OpenAI cost tracking**: every API call is logged with its token counts and an estimated cost. You get spend per day, week or month, cost per reply, month to date, a projected monthly spend, and a breakdown by model and by purpose.
- **Security**: scrypt-hashed passwords, optional TOTP two-factor auth, brute-force lockout, HttpOnly session cookies, CSRF tokens, origin checks, a strict Content-Security-Policy, secrets encrypted at rest (AES-256-GCM), and an activity log.
- **Team**: add or remove admin users.

It's built with Node.js, Express and SQLite, with a plain HTML/JS frontend. There is no separate database server and no build step.

---

## Quick start (local)

Requires **Node.js 20.12+**.

```bash
npm install
cp .env.example .env        # then fill in OPENAI_API_KEY (or add it later in Settings)
npm run create-user         # creates your admin login (asks for email + password)
npm start
```

Open http://localhost:3000 and sign in. Until Google is connected you'll see **demo mode**: sample reviews you can use to try drafting, approving and auto-approve. Nothing is posted anywhere in demo mode.

Other commands:

| Command | What it does |
|---|---|
| `npm run create-user` | Add an admin user from the command line |
| `npm run reset-password` | Reset a password (add `-- --disable-2fa` if someone lost their authenticator) |
| `npm run dev` | Start with auto-restart on file changes |

---

## Connecting Google Business Profile

Google requires an approved API project to read and reply to reviews.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **Request access** to the Business Profile APIs with Google's [access request form](https://developers.google.com/my-business/content/prereqs#request-access). Approval can take a few days. Until it comes through, API calls fail with quota or permission errors.
3. Enable these APIs in the project:
   - *My Business Account Management API*
   - *My Business Business Information API*
   - *Google My Business API* (this is where the reviews endpoints live)
4. **OAuth consent screen**: set it up and add the scope `https://www.googleapis.com/auth/business.manage`. While the app is in "Testing", add your Google account as a test user.
5. **Credentials → Create OAuth client ID → Web application.** Add this authorized redirect URI:
   ```
   <APP_URL>/api/google/callback
   ```
   e.g. `https://reviews.yourdomain.com/api/google/callback`. The Settings page shows the exact value.
6. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart.
7. In the dashboard, go to **Settings → Connect Google account**, sign in with the account that manages your business, and choose the location.

The app then syncs reviews on the interval set in Settings (default every 15 minutes). On each sync it drafts replies for new reviews and posts the ones that match your auto-approve ratings. The demo reviews are removed automatically on the first sync.

---

## OpenAI and costs

- Set `OPENAI_API_KEY` in `.env`, or paste the key in **Settings → OpenAI**. A key saved in the UI is stored encrypted and is never sent back to the browser.
- The default model is `gpt-5-mini`. You can switch to any model your key can use.
- Each draft is one request of roughly 500 input and 150–300 output tokens, a fraction of a cent on mini models.
- Costs are estimated from token counts multiplied by the per-model prices in **Settings**. The defaults are built in; check them against [openai.com/api/pricing](https://openai.com/api/pricing) and adjust as needed. Your OpenAI invoice is the source of truth.
- To keep spend bounded, each sync drafts at most 25 reviews.

---

## Deploying

Run it anywhere that runs Node or Docker (a VPS, Render, Railway, Fly.io…). Requirements:

1. **HTTPS.** Set `APP_URL=https://…` and `NODE_ENV=production`. This turns on `Secure` cookies and HSTS.
2. **Behind a proxy or load balancer**, set `TRUST_PROXY=1` so rate limiting and logs see real client IPs.
3. **A persistent disk** mounted at `data/` (or `DATA_DIR`). It holds the SQLite database.
4. **Set `APP_SECRET`** (32+ random characters) and keep it safe. It encrypts the stored Google token and OpenAI key. If you lose it, you'll need to reconnect Google and re-enter the key.
5. Create the first user with `npm run create-user`. On hosts without a shell, set `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` for the first boot, then remove them.

Docker:

```bash
docker build -t review-replies .
docker run -d -p 3000:3000 --env-file .env -v review-data:/app/data review-replies
```

---

## Security details

| Area | What's in place |
|---|---|
| Passwords | scrypt (N=2^15), 12+ characters, constant-time comparison; unknown emails still run a hash so timing doesn't reveal which accounts exist |
| Brute force | Per-email lockout after 5 failures (15 min, doubling), plus a per-IP rate limit on the login endpoint |
| 2FA | TOTP (Google Authenticator, 1Password, Authy…), with replay protection |
| Sessions | Random 256-bit tokens, stored hashed; `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS (`__Host-` prefix); 2-hour idle and 24-hour absolute timeout; a password change signs out other sessions |
| CSRF | Per-session token required on every state-changing request, plus Origin / `Sec-Fetch-Site` checks |
| Headers | Strict CSP (no inline scripts), `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy` |
| Secrets | Google refresh token and UI-saved OpenAI key encrypted with AES-256-GCM; the OpenAI key never reaches the browser |
| AI safety | Review text is passed as untrusted data, and the prompt forbids invented contact details, promises of compensation, and personal data |
| Posting | Atomic status lock, so a reply can't be posted twice |
| Audit | Sign-ins, failed sign-ins, replies, auto-posts and settings changes are logged and shown under *Team & security* |

---

## Project layout

```
server/
  index.js        Express app, security middleware, startup
  config.js       Environment config
  db.js           SQLite schema and helpers
  security.js     Hashing, encryption, TOTP
  auth.js         Sessions, CSRF, lockout, users
  openai.js       Reply generation and usage/cost logging
  google.js       OAuth and Business Profile API
  reviews.js      Sync, drafting, auto-approve, posting
  analytics.js    Analytics aggregation
  demo.js         Sample data for demo mode
  routes/         API routes
public/
  login.html, app.html
  assets/         app.js, charts.js, app.css
scripts/create-user.js
```
