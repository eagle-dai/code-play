const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCaptureTimeline,
  containsWildcards,
  resolveAnimationPattern,
  validateCaptureConfig,
  wildcardToRegExp,
} = require('../scripts/capture-animation-screenshot');

test('buildCaptureTimeline returns a monotonic sequence ending at the target', () => {
  const timeline = buildCaptureTimeline(450, 200);
  assert.deepStrictEqual(timeline, [0, 200, 400, 450]);
});

test('buildCaptureTimeline handles missing or invalid intervals by returning only the target', () => {
  assert.deepStrictEqual(buildCaptureTimeline(400, 0), [400]);
  assert.deepStrictEqual(buildCaptureTimeline(400, Number.NaN), [400]);
});

test('resolveAnimationPattern validates HTML filenames and strips nothing else', () => {
  assert.strictEqual(resolveAnimationPattern(['example.htm']), 'example.htm');
  assert.strictEqual(resolveAnimationPattern(['example.html']), 'example.html');
  assert.throws(() => resolveAnimationPattern([]), /Expected the HTML file name/);
});

test('wildcard matching utilities respect glob semantics case-insensitively', () => {
  assert.strictEqual(containsWildcards('demo.html'), false);
  assert.strictEqual(containsWildcards('demo-*.html'), true);

  const matcher = wildcardToRegExp('Demo-??.HTML');
  assert.ok(matcher.test('demo-ab.html'));
  assert.ok(matcher.test('Demo-12.htmL'));
  assert.ok(!matcher.test('demo-abc.html'));
});

test('validateCaptureConfig rejects non-finite bootstrap waits', () => {
  const validConfig = {
    minInitialRealtimeWaitMs: 120,
    maxInitialRealtimeWaitMs: 1_000,
  };

  assert.doesNotThrow(() => validateCaptureConfig(validConfig));
  assert.throws(
    () => validateCaptureConfig({ ...validConfig, minInitialRealtimeWaitMs: Infinity }),
    /finite number/
  );
  assert.throws(
    () => validateCaptureConfig({ ...validConfig, maxInitialRealtimeWaitMs: Infinity }),
    /finite number/
  );
});
