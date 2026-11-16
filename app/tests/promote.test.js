// Run: node app/tests/promote.test.js   (no dependencies)
const assert = require('assert');
const P = require('../js/promote.js');

// URLs: scheme assumed, junk refused, non-web schemes refused
assert.strictEqual(P.cleanUrl('example.com/run'), 'https://example.com/run');
assert.strictEqual(P.cleanUrl(' https://www.x.org '), 'https://www.x.org/');
assert.strictEqual(P.cleanUrl('javascript:alert(1)'), null);
assert.strictEqual(P.cleanUrl('mailto:a@b.co'), null);
assert.strictEqual(P.cleanUrl('localhost'), null);
assert.strictEqual(P.cleanUrl(''), null);
assert.strictEqual(P.normalizeUrl('https://www.x.org/a/'), P.normalizeUrl('http://x.org/a'));
assert.ok(P.isBlockedDomain('https://sub.eicar.org/x'));
assert.ok(!P.isBlockedDomain('https://noteicar.org/x'));

// keywords: lowercased, trimmed, deduped, capped
assert.deepStrictEqual(P.parseKeywords('Running, 10k ,running,, '), ['running', '10k']);
assert.strictEqual(P.parseKeywords(Array(20).fill(0).map((_, i) => 'k' + i).join(',')).length, 12);

// blocklist: case-insensitive substring, same rule as the extension
assert.strictEqual(P.blocklistHit(['casino'], 'Best CASINO', '', []), 'casino');
assert.strictEqual(P.blocklistHit(['casino'], 'ok', 'fine', ['casinos']), 'casino');
assert.strictEqual(P.blocklistHit([], 'casino', '', []), null);

// validation
const good = { url: 'example.com', title: 'T', description: 'D', keywords: 'run', email: '' };
assert.ok(P.validate(good, false).ok);
let v = P.validate(good, true);
assert.ok(!v.ok && v.errors.email && Object.keys(v.errors).length === 1);
assert.ok(P.validate(Object.assign({}, good, { email: 'a@b.co' }), true).ok);
v = P.validate({ url: 'nope', title: 'x'.repeat(81), description: '', keywords: ' , ' }, false);
assert.deepStrictEqual(Object.keys(v.errors).sort(), ['description', 'keywords', 'title', 'url']);
assert.deepStrictEqual(P.validate(good, false).value.keywords, ['run']);

// duplicates and messages
assert.ok(P.alreadyAdded([{ url: 'https://example.com/' }], 'http://www.example.com'));
assert.ok(!P.alreadyAdded([], 'https://example.com'));
assert.ok(/token/.test(P.errorMessage('INSUFFICIENT_TOKENS')));
assert.ok(/nothing was spent/.test(P.errorMessage('weird')));

console.log('promote tests passed');
