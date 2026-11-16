// Run: node app/tests/logic.test.js   (no dependencies)
const assert = require('assert');
const M = require('../js/match.js');
const G = require('../js/glad.js');

const promo = (id, o) => Object.assign({ id, url: 'https://x.test/' + id, title: id, description: '', keywords: [], budget: 5, gladYes: 0, gladNo: 0 }, o);

// glad rate: no votes = 0.5, smoothed
assert.strictEqual(M.gladRate(promo('a')), 0.5);
assert.strictEqual(M.gladRate(promo('a', { gladYes: 1 })), 0.6);
assert.strictEqual(M.gladRate(promo('a', { gladNo: 4 })), 0.25);

const profile = { moveToward: 'run a 10k by spring\nmeditation every morning', moveAway: 'gambling' };
const pool = [
  promo('lowglad', { keywords: ['meditation'], gladNo: 6 }),
  promo('highglad', { keywords: ['meditation'], gladYes: 6 }),
  promo('twohits', { keywords: ['meditation', 'spring'], gladNo: 50 }),
  promo('nobudget', { keywords: ['meditation'], budget: 0 }),
  promo('blocked', { keywords: ['meditation'], description: 'online gambling tips' }),
  promo('nomatch', { keywords: ['knitting'] }),
];
let r = M.rankPicks(pool, profile, {}).map(p => p.id);
// score first (twohits despite awful glad rate), then glad rate breaks the tie
assert.deepStrictEqual(r, ['twohits', 'highglad', 'lowglad']);
// exposure rotation: tired picks sink but still appear
r = M.rankPicks(pool, profile, { twohits: 3 }).map(p => p.id);
assert.deepStrictEqual(r, ['highglad', 'lowglad', 'twohits']);
// unmatched fallback excludes matched and zero-budget
const ranked = M.rankPicks(pool, profile, {});
assert.deepStrictEqual(M.unmatchedPicks(pool, ranked).map(p => p.id).sort(), ['blocked', 'nomatch']);
assert.deepStrictEqual(M.rankPicks([], profile, {}), []);

// glad flow with an in-memory store
(async () => {
  const data = {};
  const store = { get: (k, f) => (k in data ? JSON.parse(data[k]) : f), set: (k, v) => { data[k] = JSON.stringify(v); } };
  const sent = [];
  let online = true;
  const send = async (id, a) => { if (!online) return false; sent.push(id + ':' + a); return true; };

  for (const id of ['p1', 'p2', 'p3', 'p4']) await G.noteOpened(store, { id, title: id, url: 'u' });
  await G.noteOpened(store, { id: 'p1', title: 'p1', url: 'u' }); // opening twice asks once
  assert.strictEqual((await G.pending(store)).length, 4);

  online = false;
  let res = await G.settle(store, { p1: 'yes', p2: 'no', p3: 'later' }, send);
  assert.deepStrictEqual(res, { sent: 0, unsent: 2, deferred: 1 });
  // answered-but-unsent are not asked again; p3 (later) and p4 (untouched) are
  assert.deepStrictEqual((await G.pending(store)).map(p => p.id), ['p3', 'p4']);

  online = true;
  res = await G.flush(store, send);
  assert.deepStrictEqual(res, { sent: 2, unsent: 0 });
  assert.deepStrictEqual(sent.sort(), ['p1:yes', 'p2:no']);
  await G.flush(store, send);
  assert.strictEqual(sent.length, 2, 'never double-counted');

  // re-opening an answered pick does not re-ask
  await G.noteOpened(store, { id: 'p1', title: 'p1', url: 'u' });
  assert.deepStrictEqual((await G.pending(store)).map(p => p.id), ['p3', 'p4']);

  // "later" drops after MAX_DEFERRALS check-ins
  await G.settle(store, { p3: 'later' }, send);
  await G.settle(store, { p3: 'later' }, send);
  assert.deepStrictEqual((await G.pending(store)).map(p => p.id), ['p4']);
  console.log('logic tests passed');
})().catch(e => { console.error(e); process.exit(1); });
