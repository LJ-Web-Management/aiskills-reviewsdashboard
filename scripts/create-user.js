#!/usr/bin/env node
// Create an admin user, or reset a password:  npm run create-user  |  npm run reset-password
import readline from 'node:readline';
import { db, audit } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { hashPassword, validatePassword, normalizeEmail } from '../server/security.js';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const emailArg = args[args.indexOf('--email') + 1];

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const email = normalizeEmail(args.includes('--email') ? emailArg : await ask('Email: '));
if (!email) { console.error('Invalid email.'); process.exit(1); }

const password = await ask('Password (min 12 characters): ', { hidden: true });
const problem = validatePassword(password);
if (problem) { console.error(problem); process.exit(1); }
if ((await ask('Repeat password: ', { hidden: true })) !== password) { console.error('Passwords do not match.'); process.exit(1); }

if (reset) {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) { console.error('No user with that email.'); process.exit(1); }
  const disable2fa = args.includes('--disable-2fa');
  db.prepare(`UPDATE users SET password_hash = ?${disable2fa ? ', totp_enabled = 0, totp_secret_enc = NULL' : ''} WHERE id = ?`)
    .run(await hashPassword(password), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM login_throttle WHERE email = ?').run(email);
  audit({ id: user.id, email }, 'password_reset_cli', disable2fa ? '2FA disabled' : null);
  console.log(`Password reset for ${email}.${disable2fa ? ' Two-factor auth was turned off.' : ''} All sessions were signed out.`);
} else {
  await createUser(email, password);
  console.log(`Created user ${email}. Sign in at your APP_URL.`);
}
db.close();
