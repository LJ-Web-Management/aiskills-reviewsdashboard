import { db, audit, setSetting, getSetting } from './db.js';
import { AppError } from './security.js';
import { generateReply, MAX_REPLY_CHARS } from './openai.js';
import { getAppSettings, getGoogleConnection, getOpenAIKey, isDemoMode } from './settings.js';
import * as google from './google.js';
import { addIncomingDemoReview, clearDemoData } from './demo.js';

const MAX_DRAFTS_PER_SYNC = 25; // caps OpenAI spend per sync run

export function serializeReview(r) {
  return {
    id: r.id,
    source: r.source,
    reviewerName: r.reviewer_name || 'A Google User',
    reviewerPhoto: r.reviewer_photo || null,
    starRating: r.star_rating,
    comment: r.comment || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status,
    suggestedReply: r.suggested_reply || '',
    draftedAt: r.drafted_at,
    replyText: r.reply_text || '',
    replyAt: r.reply_at,
    autoApproved: !!r.auto_approved,
    postedBy: r.posted_by_email || null,
    error: r.error || null,
  };
}

export function getReview(id) {
  return db.prepare(`SELECT r.*, u.email AS posted_by_email FROM reviews r LEFT JOIN users u ON u.id = r.posted_by WHERE r.id = ?`).get(id);
}

export async function draftReply(review, purpose = 'draft') {
  const text = await generateReply(review, { purpose, reviewId: review.id });
  db.prepare('UPDATE reviews SET suggested_reply = ?, drafted_at = ?, error = NULL WHERE id = ?').run(text, Date.now(), review.id);
  return text;
}

/**
 * Post a reply to Google (or simulate it for demo reviews).
 * The status flip to 'posting' is atomic, so double clicks or a concurrent auto-approve can't post twice.
 */
export async function postReply(reviewId, text, { user = null, auto = false } = {}) {
  const reply = String(text || '').trim();
  if (!reply) throw new AppError('The reply is empty.');
  if (reply.length > MAX_REPLY_CHARS) throw new AppError(`Replies can be at most ${MAX_REPLY_CHARS} characters.`);

  const claimed = db.prepare(`UPDATE reviews SET status = 'posting', suggested_reply = ? WHERE id = ? AND status IN ('pending', 'failed')`)
    .run(reply, reviewId).changes;
  if (!claimed) throw new AppError('This review was already handled. Refresh to see its latest status.', 409);

  const review = getReview(reviewId);
  try {
    if (review.source === 'google') await google.postReply(review.external_id, reply);
    const now = Date.now();
    db.prepare(`UPDATE reviews SET status = 'posted', reply_text = ?, reply_at = ?, auto_approved = ?, posted_by = ?, error = NULL WHERE id = ?`)
      .run(reply, now, auto ? 1 : 0, user?.id ?? null, reviewId);
    audit(user, auto ? 'reply_auto_posted' : 'reply_posted', `${review.star_rating}★ review by ${review.reviewer_name}`);
  } catch (err) {
    db.prepare(`UPDATE reviews SET status = 'failed', error = ? WHERE id = ?`).run(String(err.message).slice(0, 500), reviewId);
    audit(user, 'reply_failed', `${review.reviewer_name}: ${err.message}`.slice(0, 500));
    throw err;
  }
  return getReview(reviewId);
}

function upsertGoogleReviews(items) {
  const now = Date.now();
  const find = db.prepare('SELECT id, status, comment FROM reviews WHERE external_id = ?');
  const insert = db.prepare(`INSERT INTO reviews (external_id, source, reviewer_name, reviewer_photo, star_rating, comment, created_at, updated_at,
                              status, reply_text, reply_at, first_seen_at)
                             VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE reviews SET reviewer_name = ?, reviewer_photo = ?, star_rating = ?, comment = ?, updated_at = ? WHERE id = ?`);
  const markReplied = db.prepare(`UPDATE reviews SET status = 'replied', reply_text = ?, reply_at = ?, error = NULL WHERE id = ?`);
  const resetDraft = db.prepare('UPDATE reviews SET suggested_reply = NULL, drafted_at = NULL WHERE id = ?');
  let added = 0;
  db.transaction(() => {
    for (const r of items) {
      const row = find.get(r.externalId);
      if (!row) {
        insert.run(r.externalId, r.reviewerName, r.reviewerPhoto, r.starRating, r.comment, r.createdAt, r.updatedAt,
          r.reply ? 'replied' : 'pending', r.reply?.text ?? null, r.reply?.at ?? null, now);
        added++;
        continue;
      }
      update.run(r.reviewerName, r.reviewerPhoto, r.starRating, r.comment, r.updatedAt, row.id);
      if (r.reply && ['pending', 'failed', 'skipped'].includes(row.status)) {
        markReplied.run(r.reply.text, r.reply.at, row.id); // someone replied directly on Google
      } else if (!r.reply && row.status === 'pending' && row.comment !== r.comment) {
        resetDraft.run(row.id); // reviewer edited their review: draft again
      }
    }
  })();
  return added;
}

/** Draft replies for pending reviews and auto-post those whose rating is set to auto-approve. */
async function processPending(summary) {
  const settings = getAppSettings();
  const autoStars = settings.autoApprove.enabled ? settings.autoApprove.stars : [];

  if (getOpenAIKey()) {
    const needDraft = db.prepare(`SELECT * FROM reviews WHERE status = 'pending' AND suggested_reply IS NULL ORDER BY created_at DESC LIMIT ?`)
      .all(MAX_DRAFTS_PER_SYNC * 4)
      .filter((r) => settings.autoDraft || autoStars.includes(r.star_rating))
      .slice(0, MAX_DRAFTS_PER_SYNC);
    for (const review of needDraft) {
      try {
        await draftReply(review, 'draft');
        summary.drafted++;
      } catch (err) {
        summary.errors.push(`Drafting failed: ${err.message}`);
        break; // most likely a key/quota problem; don't hammer the API
      }
    }
  } else if (db.prepare(`SELECT 1 FROM reviews WHERE status = 'pending' AND suggested_reply IS NULL LIMIT 1`).get()) {
    summary.errors.push('No OpenAI API key, so new reviews were not drafted.');
  }

  if (autoStars.length) {
    const marks = autoStars.map(() => '?').join(',');
    const toPost = db.prepare(`SELECT id, suggested_reply FROM reviews WHERE status = 'pending' AND suggested_reply IS NOT NULL
                               AND star_rating IN (${marks}) ORDER BY created_at ASC`).all(...autoStars);
    for (const r of toPost) {
      try {
        await postReply(r.id, r.suggested_reply, { auto: true });
        summary.autoPosted++;
      } catch (err) {
        summary.errors.push(`Auto-post failed: ${err.message}`);
      }
    }
  }
}

let running = null;

export function runSync({ manual = false, user = null } = {}) {
  if (running) return running;
  running = (async () => {
    const summary = { startedAt: Date.now(), fetched: 0, newReviews: 0, drafted: 0, autoPosted: 0, errors: [] };
    try {
      const conn = getGoogleConnection();
      if (conn?.locationName && !conn.needsReconnect) {
        const items = await google.fetchReviews(conn.accountName, conn.locationName, { sinceMs: conn.watermark || 0 });
        summary.fetched = items.length;
        if (items.length) {
          if (!conn.watermark) clearDemoData();
          summary.newReviews = upsertGoogleReviews(items);
          const newest = Math.max(...items.map((i) => i.updatedAt || 0));
          setSettingMerge('google', { watermark: Math.max(conn.watermark || 0, newest) });
        }
      } else if (isDemoMode() && manual) {
        if (addIncomingDemoReview()) summary.newReviews = 1;
      }
      await processPending(summary);
    } catch (err) {
      summary.errors.push(err.message);
    }
    summary.finishedAt = Date.now();
    summary.ok = summary.errors.length === 0;
    setSetting('lastSync', summary);
    if (manual) audit(user, 'sync', `${summary.newReviews} new, ${summary.drafted} drafted, ${summary.autoPosted} auto-posted`);
    return summary;
  })().finally(() => { running = null; });
  return running;
}

function setSettingMerge(key, patch) {
  setSetting(key, { ...(getSetting(key, {}) || {}), ...patch });
}

let timer = null;

export function startScheduler() {
  const tick = async () => {
    try {
      await runSync();
    } catch (err) {
      console.error('[sync]', err);
    }
    const minutes = getAppSettings().syncIntervalMinutes;
    timer = setTimeout(tick, minutes * 60_000);
    timer.unref?.();
  };
  timer = setTimeout(tick, 5_000);
  timer.unref?.();
}
