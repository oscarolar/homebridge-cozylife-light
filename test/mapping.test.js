const {test} = require('node:test');
const assert = require('node:assert');
const m = require('../dist/mapping');

test('Matter level 1..254 maps to 0..100 % and round-trips from percent', () => {
  assert.strictEqual(m.levelToPercent(1), 0);
  assert.strictEqual(m.levelToPercent(254), 100);
  assert.strictEqual(m.levelToPercent(2), 1, 'just above minimum is still lit');
  assert.strictEqual(m.levelToPercent(0), 0);
  assert.strictEqual(m.levelToPercent(255), 100);
  assert.strictEqual(m.percentToLevel(0), 1);
  assert.strictEqual(m.levelToLitPercent(1), 1, 'a lit bulb never gets brightness 0');
  assert.strictEqual(m.levelToLitPercent(254), 100);
  assert.strictEqual(m.percentToLevel(100), 254);
  for (let percent = 0; percent <= 100; percent++) {
    assert.strictEqual(m.levelToPercent(m.percentToLevel(percent)), percent);
  }
});

test('Matter hue 0..254 maps to 0..360 degrees and round-trips from Matter', () => {
  assert.strictEqual(m.matterHueToDegrees(0), 0);
  assert.strictEqual(m.matterHueToDegrees(254), 360);
  assert.strictEqual(m.degreesToMatterHue(120), 85);
  assert.strictEqual(m.enhancedHueToDegrees(65535), 360);
  for (let hue = 0; hue <= 254; hue++) {
    assert.strictEqual(m.degreesToMatterHue(m.matterHueToDegrees(hue)), hue);
  }
});

test('Matter saturation 0..254 maps to 0..100 % and round-trips from percent', () => {
  assert.strictEqual(m.matterSaturationToPercent(254), 100);
  assert.strictEqual(m.percentToMatterSaturation(50), 127);
  for (let percent = 0; percent <= 100; percent++) {
    assert.strictEqual(m.matterSaturationToPercent(m.percentToMatterSaturation(percent)), percent);
  }
});

test('mireds are clamped to the bulb range', () => {
  assert.strictEqual(m.clampMired(100), 140);
  assert.strictEqual(m.clampMired(600), 500);
  assert.strictEqual(m.clampMired(370.4), 370);
});

test('xy and hue/saturation convert both ways', () => {
  const red = m.xyToHueSaturation(Math.round(0.64 * 65535), Math.round(0.33 * 65535));
  assert.ok(red.hue <= 1 || red.hue >= 359, `red hue ${red.hue}`);
  assert.ok(red.saturation >= 99, `red saturation ${red.saturation}`);
  const white = m.xyToHueSaturation(Math.round(0.3127 * 65535), Math.round(0.329 * 65535));
  assert.ok(white.saturation <= 1, `D65 saturation ${white.saturation}`);
  for (const hue of [0, 30, 60, 120, 180, 240, 300]) {
    for (const saturation of [30, 60, 100]) {
      const {x, y} = m.hueSaturationToXy(hue, saturation);
      const back = m.xyToHueSaturation(x, y);
      const hueError = Math.min(Math.abs(back.hue - hue), 360 - Math.abs(back.hue - hue));
      assert.ok(hueError <= 1 && Math.abs(back.saturation - saturation) <= 1,
        `${hue}/${saturation} -> ${x},${y} -> ${back.hue}/${back.saturation}`);
    }
  }
});
