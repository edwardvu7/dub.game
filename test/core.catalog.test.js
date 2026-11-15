const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../voices_catalog.json');

test('voice catalog is well-formed', () => {
  assert.ok(catalog.length >= 24);
  const ids = new Set();
  for (const v of catalog) {
    for (const k of ['voice_id', 'name', 'description']) {
      assert.strictEqual(typeof v[k], 'string', k);
      assert.ok(v[k].trim(), k);
    }
    assert.match(v.voice_id, /^[A-Za-z0-9]{20}$/);
    assert.ok(v.description.length <= 45, `${v.name} description too long`);
    ids.add(v.voice_id);
  }
  assert.strictEqual(ids.size, catalog.length, 'duplicate voice_id');
});

test('voice catalog is balanced', () => {
  const n = (re) => catalog.filter((v) => re.test(v.description)).length;
  assert.ok(n(/\bwoman\b|\bgirl\b/) >= 8);
  assert.ok(n(/\bman\b/) >= 8);
  assert.ok(n(/American/) >= 8);
  assert.ok(n(/older|middle-aged|40s/) >= 3);
  assert.ok(catalog.length - n(/British|Australian/) >= 15);
});
