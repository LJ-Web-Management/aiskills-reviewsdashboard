// Sample reviews so the dashboard can be tried before Google is connected.
// They are marked source = 'demo' and are removed automatically once a Google location syncs.
import { db } from './db.js';

const DAY = 86_400_000;

// [name, stars, text, daysAgo, outcome]  outcome: pending | auto | manual | replied | skipped
const SEED = [
  ['Maya Thompson', 5, 'Best flat white in town, hands down. The staff remembered my order on my second visit, which made my morning.', 1, 'pending'],
  ['Daniel Okafor', 4, 'Lovely spot for a quiet work session. Wi-Fi was quick and the banana bread was excellent. Only wish there were more power outlets.', 2, 'pending'],
  ['Priya Raman', 2, 'Waited almost 25 minutes for two sandwiches on a Saturday and one order was wrong. Food was fine once it arrived, but the wait was frustrating.', 2, 'pending'],
  ['A Google User', 5, '', 3, 'pending'],
  ['Lucas Meyer', 3, 'Coffee was good but the place was really loud and every table was sticky. Might come back on a weekday.', 4, 'pending'],
  ['Hannah Lee', 5, 'We had my daughter\'s birthday brunch here and the team went above and beyond. They even brought out a candle in her pancakes!', 5, 'pending'],
  ['Tom Becker', 1, 'Found a hair in my salad and when I mentioned it the server just shrugged. Not acceptable.', 6, 'pending'],
  ['Sofia Alvarez', 4, 'Great almond croissants and friendly baristas. Parking nearby is tricky though.', 7, 'pending'],
  ['James Carter', 5, 'Cozy, bright and the oat latte is perfect. My new favourite cafe.', 9, 'auto'],
  ['Emily Nguyen', 5, 'The breakfast burrito is huge and delicious. Staff were so welcoming.', 12, 'auto'],
  ['Oliver Smith', 4, 'Solid coffee, nice music, good vibe. A bit pricey but worth it.', 14, 'manual'],
  ['Chloe Martin', 5, 'Came for the matcha, stayed for the lemon tart. Absolutely lovely place.', 17, 'auto'],
  ['Noah Williams', 2, 'Ordered online for pickup and it wasn\'t ready for 15 minutes after the pickup time.', 19, 'manual'],
  ['Ava Johnson', 5, 'Dog friendly patio and they gave my pup a treat. 10/10.', 22, 'auto'],
  ['Liam Brown', 5, '', 25, 'auto'],
  ['Isabella Garcia', 3, 'Food is tasty but portions felt small for the price.', 28, 'manual'],
  ['Ethan Davis', 5, 'Their seasonal pumpkin spice latte is not too sweet, just right. Friendly staff too.', 33, 'auto'],
  ['Mia Wilson', 4, 'Very good sourdough toast. Service was a little slow but friendly.', 38, 'manual'],
  ['Lucas Anderson', 5, 'Perfect spot to meet friends. Great playlist and comfy chairs.', 42, 'replied'],
  ['Zoe Taylor', 1, 'Rude barista at the counter this morning. Will not be back.', 47, 'manual'],
  ['Benjamin Thomas', 5, 'Best cinnamon rolls I have ever had. Fresh and warm.', 51, 'auto'],
  ['Grace Moore', 4, 'Nice atmosphere and tasty chai. Would love some vegan pastry options.', 56, 'manual'],
  ['Henry Jackson', 5, 'Consistently great coffee every single time.', 63, 'auto'],
  ['Lily White', 5, 'Staff are always smiling. Love supporting this local gem.', 70, 'replied'],
  ['Samuel Harris', 3, 'Average coffee, nice decor.', 77, 'skipped'],
  ['Ella Clark', 5, 'The avocado toast is next level. Will be back next weekend.', 84, 'auto'],
  ['Jack Lewis', 4, 'Good spot, friendly service, decent prices.', 91, 'manual'],
  ['Amelia Robinson', 5, 'Beautiful latte art and the quietest corner for reading.', 99, 'replied'],
  ['William Walker', 2, 'My cappuccino was lukewarm and the table hadn\'t been cleared.', 106, 'manual'],
  ['Harper Young', 5, 'Gorgeous little cafe, great service, amazing scones.', 113, 'auto'],
  ['Leo King', 5, 'Fantastic espresso. Owner clearly cares about quality.', 121, 'replied'],
  ['Aria Scott', 4, 'Great pastries, a bit crowded at lunch.', 130, 'manual'],
  ['Mason Green', 5, 'Always a pleasure. The team is wonderful.', 140, 'auto'],
  ['Layla Adams', 5, 'Excellent brunch menu and quick service.', 152, 'replied'],
  ['Ryan Baker', 3, 'Okay coffee. The muffins were a bit dry.', 165, 'manual'],
  ['Nora Hill', 5, 'My go-to cafe before work. Never disappoints.', 178, 'auto'],
];

// Reviews that "arrive" each time Sync now is pressed in demo mode.
const INCOMING = [
  ['Ruby Campbell', 5, 'Stopped in on a rainy afternoon and the hot chocolate was exactly what I needed. Lovely team.'],
  ['Arjun Mehta', 4, 'Good coffee and a calm space to work. Pastry case was nearly empty by 2pm.'],
  ['Claire Dubois', 5, 'Le meilleur café du quartier ! Le personnel est adorable.'],
  ['Marcus Reed', 1, 'Charged twice on my card and nobody could help me sort it out.'],
  ['Elena Rossi', 5, ''],
  ['Kenji Watanabe', 3, 'Nice latte, but the music was too loud to have a conversation.'],
  ['Fatima Khan', 5, 'Gluten-free options that actually taste great. Thank you!'],
  ['Owen Murphy', 2, 'The sandwich was fine but the bread was stale.'],
];

function firstName(name) {
  return name === 'A Google User' ? '' : ` ${name.split(' ')[0]}`;
}

function cannedReply(name, stars) {
  const n = firstName(name);
  if (stars >= 5) return `Thank you so much${n}! We're thrilled you enjoyed your visit and can't wait to see you again soon.\n— The Harbor & Pine team`;
  if (stars === 4) return `Thanks for the great review${n}! We're glad you had a good time, and we've passed your feedback on to the team.\n— The Harbor & Pine team`;
  if (stars === 3) return `Thanks for the honest feedback${n}. We're always working to improve and hope we can make your next visit a five-star one.\n— The Harbor & Pine team`;
  return `${n ? `Hi${n}, ` : ''}we're really sorry your visit fell short. That isn't the experience we want for anyone. Please reach out to us directly so we can make it right.\n— The Harbor & Pine team`;
}

export function seedDemoData() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n;
  if (existing > 0) return false;
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO reviews
    (external_id, source, reviewer_name, star_rating, comment, created_at, updated_at, status, suggested_reply, drafted_at, reply_text, reply_at, auto_approved, first_seen_at)
    VALUES (@external_id, 'demo', @name, @stars, @text, @created, @created, @status, @suggested, @drafted, @reply, @replyAt, @auto, @created)`);
  db.transaction(() => {
    SEED.forEach(([name, stars, text, daysAgo, outcome], i) => {
      // Spread times through the day so charts look natural.
      const created = now - daysAgo * DAY - ((i * 7919) % 36_000_000);
      const reply = outcome === 'pending' || outcome === 'skipped' ? null : cannedReply(name, stars);
      const delayH = outcome === 'auto' ? 0.3 + (i % 3) * 0.4 : outcome === 'replied' ? 30 + (i % 4) * 10 : 4 + (i % 5) * 6;
      insert.run({
        external_id: `demo-${i + 1}`,
        name, stars, text, created,
        status: { pending: 'pending', auto: 'posted', manual: 'posted', replied: 'replied', skipped: 'skipped' }[outcome],
        suggested: reply,
        drafted: reply ? created : null,
        reply,
        replyAt: reply ? created + delayH * 3_600_000 : null,
        auto: outcome === 'auto' ? 1 : 0,
      });
    });
  })();
  return true;
}

export function addIncomingDemoReview() {
  const used = new Set(db.prepare("SELECT external_id FROM reviews WHERE external_id LIKE 'demo-in-%'").all().map((r) => r.external_id));
  const idx = INCOMING.findIndex((_, i) => !used.has(`demo-in-${i}`));
  if (idx === -1) return null;
  const [name, stars, text] = INCOMING[idx];
  const now = Date.now();
  db.prepare(`INSERT INTO reviews (external_id, source, reviewer_name, star_rating, comment, created_at, updated_at, status, first_seen_at)
              VALUES (?, 'demo', ?, ?, ?, ?, ?, 'pending', ?)`).run(`demo-in-${idx}`, name, stars, text, now, now, now);
  return name;
}

export function clearDemoData() {
  return db.prepare("DELETE FROM reviews WHERE source = 'demo'").run().changes;
}
