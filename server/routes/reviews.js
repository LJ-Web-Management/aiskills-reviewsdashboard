import express from 'express';
import { db, audit } from '../db.js';
import { AppError } from '../security.js';
import { MAX_REPLY_CHARS } from '../openai.js';
import { serializeReview, getReview, draftReply, postReply, runSync } from '../reviews.js';

const router = express.Router();

const STATUS_FILTERS = {
  pending: ["'pending'", "'failed'", "'posting'"],
  posted: ["'posted'"],
  replied: ["'replied'"],
  skipped: ["'skipped'"],
};

function loadReview(req) {
  const review = getReview(Number(req.params.id));
  if (!review) throw new AppError('Review not found.', 404);
  return review;
}

router.get('/reviews', (req, res) => {
  const status = STATUS_FILTERS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'pending';
  const where = [];
  const params = [];
  if (status !== 'all') where.push(`r.status IN (${STATUS_FILTERS[status].join(',')})`);

  const stars = String(req.query.stars || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  if (stars.length) {
    where.push(`r.star_rating IN (${stars.map(() => '?').join(',')})`);
    params.push(...stars);
  }
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(r.comment LIKE ? ESCAPE '\\' OR r.reviewer_name LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`SELECT r.*, u.email AS posted_by_email FROM reviews r LEFT JOIN users u ON u.id = r.posted_by
                           ${whereSql} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM reviews r ${whereSql}`).get(...params).n;

  const counts = { pending: 0, posted: 0, replied: 0, skipped: 0, all: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM reviews GROUP BY status').all()) {
    counts.all += row.n;
    if (['pending', 'failed', 'posting'].includes(row.status)) counts.pending += row.n;
    else if (counts[row.status] !== undefined) counts[row.status] += row.n;
  }
  res.json({ reviews: rows.map(serializeReview), total, counts, limit, offset });
});

router.post('/reviews/:id/generate', async (req, res) => {
  const review = loadReview(req);
  if (!['pending', 'failed'].includes(review.status)) throw new AppError('This review already has a reply.', 409);
  await draftReply(review, review.suggested_reply ? 'regenerate' : 'draft');
  res.json({ review: serializeReview(getReview(review.id)) });
});

router.patch('/reviews/:id', (req, res) => {
  const review = loadReview(req);
  if (!['pending', 'failed'].includes(review.status)) throw new AppError('This review already has a reply.', 409);
  const text = String(req.body?.suggestedReply ?? '').slice(0, MAX_REPLY_CHARS);
  db.prepare('UPDATE reviews SET suggested_reply = ? WHERE id = ?').run(text, review.id);
  res.json({ review: serializeReview(getReview(review.id)) });
});

router.post('/reviews/:id/approve', async (req, res) => {
  const review = loadReview(req);
  const updated = await postReply(review.id, req.body?.reply ?? review.suggested_reply, { user: req.user });
  res.json({ review: serializeReview(updated) });
});

router.post('/reviews/:id/skip', (req, res) => {
  const review = loadReview(req);
  const changed = db.prepare(`UPDATE reviews SET status = 'skipped' WHERE id = ? AND status IN ('pending', 'failed')`).run(review.id).changes;
  if (!changed) throw new AppError('Only reviews awaiting a reply can be skipped.', 409);
  audit(req.user, 'review_skipped', `${review.star_rating}★ review by ${review.reviewer_name}`);
  res.json({ review: serializeReview(getReview(review.id)) });
});

router.post('/reviews/:id/restore', (req, res) => {
  const review = loadReview(req);
  const changed = db.prepare(`UPDATE reviews SET status = 'pending', error = NULL WHERE id = ? AND status IN ('skipped', 'failed')`).run(review.id).changes;
  if (!changed) throw new AppError('Only skipped or failed reviews can be moved back.', 409);
  res.json({ review: serializeReview(getReview(review.id)) });
});

router.post('/sync', async (req, res) => {
  const summary = await runSync({ manual: true, user: req.user });
  res.json({ summary });
});

export default router;
