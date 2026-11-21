import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCode, normalizeCode, isValidCode, peerIdFor, sendUrl, validateImageMsg, fitSize,
  ALPHABET, CODE_LEN, MAX_BYTES, PREFIX,
} from '../transfer.js';

test('makeCode: 6 символов из безопасного алфавита', () => {
  for (let i = 0; i < 200; i++) {
    const c = makeCode();
    assert.equal(c.length, CODE_LEN);
    assert.ok(isValidCode(c), c);
    assert.ok(!/[01OI]/.test(c), 'без путаницы 0/O и 1/I');
  }
  let seed = 0;
  const fixed = () => ((seed = (seed + 0.37) % 1));
  assert.equal(makeCode(fixed).length, 6);
  assert.ok([...makeCode(() => 0.999999)].every((ch) => ch === ALPHABET.at(-1)));
});

test('normalizeCode: регистр, пробелы, дефисы, лишние символы', () => {
  assert.equal(normalizeCode(' ab c-23x4 '), 'ABC23X');
  assert.equal(normalizeCode('k7m2pq99'), 'K7M2PQ');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode('0O1I'), '');
});

test('isValidCode', () => {
  assert.ok(isValidCode('ABC234'));
  assert.ok(!isValidCode('ABC23'));
  assert.ok(!isValidCode('abc234'));
  assert.ok(!isValidCode('ABC230'));
  assert.ok(!isValidCode(123456));
});

test('peerIdFor и sendUrl', () => {
  assert.equal(peerIdFor('ABC234'), PREFIX + 'ABC234');
  assert.equal(sendUrl('https://x.github.io/bento-ar/', 'ABC234'), 'https://x.github.io/bento-ar/send.html#ABC234');
  assert.equal(sendUrl('https://x.github.io/bento-ar/index.html?a=1', 'ABC234'), 'https://x.github.io/bento-ar/send.html#ABC234');
});

test('validateImageMsg', () => {
  const ok = { type: 'image', mime: 'image/jpeg', data: new ArrayBuffer(10) };
  assert.equal(validateImageMsg(ok), null);
  assert.equal(validateImageMsg({ ...ok, data: new Uint8Array(5) }), null);
  assert.equal(validateImageMsg(null), 'bad-type');
  assert.equal(validateImageMsg({ ...ok, type: 'text' }), 'bad-type');
  assert.equal(validateImageMsg({ ...ok, mime: 'text/html' }), 'bad-mime');
  assert.equal(validateImageMsg({ ...ok, mime: 'image/svg+xml' }), 'bad-mime');
  assert.equal(validateImageMsg({ ...ok, data: new ArrayBuffer(0) }), 'empty');
  assert.equal(validateImageMsg({ ...ok, data: 'abc' }), 'empty');
  assert.equal(validateImageMsg({ ...ok, data: new ArrayBuffer(MAX_BYTES + 1) }), 'too-big');
});

test('fitSize: ужимает по большей стороне, маленькие не трогает', () => {
  assert.deepEqual(fitSize(4032, 3024, 2048), { w: 2048, h: 1536 });
  assert.deepEqual(fitSize(3024, 4032, 2048), { w: 1536, h: 2048 });
  assert.deepEqual(fitSize(800, 600, 2048), { w: 800, h: 600 });
});
