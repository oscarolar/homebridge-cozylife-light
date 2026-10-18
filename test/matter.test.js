const {test} = require('node:test');
const assert = require('node:assert');
const {CozyLifeDevice} = require('../dist/device');
const {CozyLifeMatterLight} = require('../dist/matter');
const {fakeBulb, statefulBulb, sets, log, tick, fakeApi} = require('./helpers');

async function setup({attrs = {1: 0, 3: 0, 4: 500, 5: 65535, 6: 65535}, reply, color} = {}) {
  const bulb = await fakeBulb({reply: reply ?? statefulBulb(attrs)});
  const api = fakeApi();
  const device = new CozyLifeDevice({name: 'Lamp', ip: '127.0.0.1', port: bulb.port, color}, log);
  const light = new CozyLifeMatterLight(api.matter, device, 'matter-uuid', {did: 'abc', pid: 'L5', sv: '1.0.8'}, log);
  api.matter.seed(light.accessory);
  await light.whenRegistered();
  await tick();
  api.calls.updates.length = 0;
  return {bulb, api, device, light, handlers: light.accessory.handlers};
}

test('the Matter accessory describes a color light with the bulb ranges', async () => {
  const {bulb, light} = await setup();
  const a = light.accessory;
  assert.strictEqual(a.UUID, 'matter-uuid');
  assert.strictEqual(a.deviceType.name, 'ExtendedColorLight');
  assert.deepStrictEqual([a.serialNumber, a.manufacturer, a.model, a.firmwareRevision], ['abc', 'CozyLife', 'L5', '1.0.8']);
  assert.deepStrictEqual(a.clusters.levelControl, {currentLevel: 254, minLevel: 1, maxLevel: 254});
  assert.strictEqual(a.clusters.colorControl.colorTempPhysicalMinMireds, 140);
  assert.strictEqual(a.clusters.colorControl.colorTempPhysicalMaxMireds, 500);
  for (const name of ['moveToHueAndSaturationLogic', 'moveToHueLogic', 'moveToSaturationLogic', 'moveToColorLogic',
    'moveToColorTemperatureLogic', 'stopAllColorMovement']) {
    assert.strictEqual(typeof a.handlers.colorControl[name], 'function', name);
  }
  bulb.close();
});

test('a white-only bulb is a ColorTemperatureLight without hue/saturation/xy handlers', async () => {
  const {bulb, light} = await setup({color: false});
  assert.strictEqual(light.accessory.deviceType.name, 'ColorTemperatureLight');
  assert.deepStrictEqual(Object.keys(light.accessory.handlers.colorControl).sort(),
    ['moveToColorTemperatureLogic', 'stopAllColorMovement']);
  assert.ok(!('currentHue' in light.accessory.clusters.colorControl));
  bulb.close();
});

test('on/off/toggle and level commands write to the bulb', async () => {
  const {bulb, device, handlers} = await setup();
  await handlers.onOff.on();
  await handlers.levelControl.moveToLevel({level: 128});
  await handlers.onOff.toggle();
  await handlers.levelControl.moveToLevelWithOnOff({level: 1});
  await handlers.levelControl.moveToLevelWithOnOff({level: 254});
  await handlers.levelControl.step({stepMode: 1, stepSize: 127});
  assert.deepStrictEqual(sets(bulb), [{1: 255}, {4: 500}, {1: 0}, {1: 0}, {1: 255, 4: 1000}, {4: 500}]);
  assert.strictEqual(device.state.on, true);
  bulb.close();
});

test('MoveToHueAndSaturation is one write even though matter.js then calls the hue and saturation handlers', async () => {
  const {bulb, handlers} = await setup();
  await handlers.colorControl.moveToHueAndSaturationLogic({hue: 85, saturation: 254, transitionTime: 0});
  await handlers.colorControl.moveToHueLogic({targetHue: 85, direction: 0, transitionTime: 0, isEnhancedHue: false});
  await handlers.colorControl.moveToSaturationLogic({targetSaturation: 254, transitionTime: 0});
  assert.deepStrictEqual(sets(bulb), [{2: 0, 5: 120, 6: 1000}]);
  await handlers.colorControl.moveToSaturationLogic({targetSaturation: 127, transitionTime: 0});
  assert.deepStrictEqual(sets(bulb)[1], {2: 0, 5: 120, 6: 500});
  bulb.close();
});

test('xy and color temperature commands write hue/saturation and white', async () => {
  const {bulb, handlers} = await setup();
  await handlers.colorControl.moveToColorLogic({targetX: Math.round(0.64 * 65535), targetY: Math.round(0.33 * 65535), transitionTime: 0});
  await handlers.colorControl.moveToColorTemperatureLogic({colorTemperatureMireds: 370, transitionTime: 0});
  await handlers.colorControl.moveToColorTemperatureLogic({colorTemperatureMireds: 1000, transitionTime: 0});
  const [red, warm, warmest] = sets(bulb);
  assert.strictEqual(red[2], 0);
  assert.ok(red[5] <= 1 || red[5] >= 359);
  assert.ok(red[6] >= 990);
  assert.deepStrictEqual(warm, {2: 0, 3: 260});
  assert.deepStrictEqual(warmest, {2: 0, 3: 0});
  bulb.close();
});

test('a failed write is reported as a Matter status error', async () => {
  const {bulb, api, handlers} = await setup({reply: request => ({...request, msg: {}, res: 1})});
  await assert.rejects(handlers.onOff.on(), api.matter.status.Failure);
  bulb.close();
});

test('after a poll only changed attributes are pushed, and commanded values are not echoed back', async () => {
  const attrs = {1: 1, 3: 260, 4: 500, 5: 240, 6: 500};
  const {bulb, api, device, handlers} = await setup({attrs});
  await device['poll']();
  await tick();
  assert.deepStrictEqual(api.calls.updates.map(u => u.cluster).sort(), ['colorControl', 'levelControl', 'onOff']);

  api.calls.updates.length = 0;
  await device['poll']();
  await tick();
  assert.deepStrictEqual(api.calls.updates, [], 'nothing changed');

  await handlers.levelControl.moveToLevel({level: 254});
  api.matter.commit('matter-uuid', 'levelControl', {currentLevel: 254}); // matter.js commits after the handler
  await tick();
  assert.deepStrictEqual(api.calls.updates, [], 'the endpoint already holds the commanded level');

  attrs[1] = 0; // wall switch
  await device['poll']();
  await tick();
  assert.deepStrictEqual(api.calls.updates, [{uuid: 'matter-uuid', cluster: 'onOff', attributes: {onOff: false}}]);
  bulb.close();
});

test('a failed push is retried on the next update', async () => {
  const {bulb, api, device} = await setup({attrs: {1: 1, 4: 1000}});
  let fail = true;
  const update = api.matter.updateAccessoryState;
  api.matter.updateAccessoryState = async (...args) => {
    if (fail) {
      throw new Error('not registered yet');
    }
    return update(...args);
  };
  await device['poll']();
  await tick();
  await tick();
  fail = false;
  await device['poll']();
  await tick();
  assert.ok(api.calls.updates.some(u => u.cluster === 'onOff' && u.attributes.onOff === true));
  bulb.close();
});

test('nothing is pushed until the endpoint exists, then the full state is', async () => {
  const bulb = await fakeBulb({reply: statefulBulb({1: 1, 4: 500})});
  const api = fakeApi();
  let exists = false;
  const get = api.matter.getAccessoryState;
  api.matter.getAccessoryState = async (...args) => exists ? get(...args) : undefined;
  const device = new CozyLifeDevice({name: 'Lamp', ip: '127.0.0.1', port: bulb.port}, log);
  const light = new CozyLifeMatterLight(api.matter, device, 'matter-uuid', {}, log);
  const registered = light.whenRegistered();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepStrictEqual(api.calls.updates, [], 'not registered yet');
  await device['poll']();
  await tick();
  assert.deepStrictEqual(api.calls.updates, [], 'still not registered');
  api.matter.seed(light.accessory);
  exists = true;
  await registered;
  await tick();
  assert.deepStrictEqual(api.calls.updates.map(u => u.cluster).sort(), ['levelControl', 'onOff']);
  assert.deepStrictEqual(api.calls.updates.find(u => u.cluster === 'onOff').attributes, {onOff: true});
  bulb.close();
});

test('a restored endpoint keeps its state until the first poll', async () => {
  const {bulb, api, device} = await setup({attrs: {1: 1, 4: 1000}});
  await tick();
  assert.deepStrictEqual(api.calls.updates, [], 'defaults are not pushed');
  await device['poll']();
  await tick();
  assert.deepStrictEqual(api.calls.updates.find(u => u.cluster === 'onOff').attributes, {onOff: true});
  bulb.close();
});

test('drift made by matter.js on its own (move, stepWithOnOff, color move) is corrected on the next poll', async () => {
  const {bulb, api, device} = await setup({attrs: {1: 1, 3: 260, 4: 500, 5: 240, 6: 500}});
  await device['poll']();
  await tick();
  api.calls.updates.length = 0;
  api.matter.commit('matter-uuid', 'levelControl', {currentLevel: 200});
  api.matter.commit('matter-uuid', 'colorControl', {currentHue: 10});
  await device['poll']();
  await tick();
  const pushed = Object.fromEntries(api.calls.updates.map(u => [u.cluster, u.attributes]));
  assert.deepStrictEqual(pushed.levelControl, {currentLevel: 128});
  assert.strictEqual(pushed.colorControl.currentHue, 169);
  assert.ok(!pushed.onOff);
  bulb.close();
});

test('commanded values are kept as matter.js committed them, without rounding write-backs', async () => {
  const {bulb, api, device, handlers} = await setup({attrs: {1: 1, 3: 260, 4: 500, 5: 65535, 6: 65535}});
  await device['poll']();
  await tick();
  api.calls.updates.length = 0;
  await handlers.levelControl.moveToLevel({level: 127}); // 50 %, which maps back to 128
  api.matter.commit('matter-uuid', 'levelControl', {currentLevel: 127});
  await handlers.colorControl.moveToHueAndSaturationLogic({hue: 100, saturation: 200, transitionTime: 0});
  api.matter.commit('matter-uuid', 'colorControl', {currentHue: 100, currentSaturation: 200, colorMode: 0, enhancedColorMode: 0});
  await tick();
  await device['poll']();
  await tick();
  assert.deepStrictEqual(api.calls.updates, []);
  bulb.close();
});

test('a slow bulb does not break the MoveToHueAndSaturation echo, and a failed write clears it', async () => {
  const bulb = await fakeBulb({delayMs: 400, reply: statefulBulb({})});
  const api = fakeApi();
  const device = new CozyLifeDevice({name: 'Lamp', ip: '127.0.0.1', port: bulb.port}, log);
  const {handlers} = new CozyLifeMatterLight(api.matter, device, 'u', {}, log).accessory;
  await handlers.colorControl.moveToHueAndSaturationLogic({hue: 85, saturation: 254, transitionTime: 50});
  await handlers.colorControl.moveToHueLogic({targetHue: 85, isEnhancedHue: false});
  await handlers.colorControl.moveToSaturationLogic({targetSaturation: 254});
  assert.strictEqual(sets(bulb).length, 1);
  bulb.close();

  let fail = true;
  const flaky = await fakeBulb({reply: request => ({...request, msg: {}, res: fail ? 1 : 0})});
  const device2 = new CozyLifeDevice({name: 'Lamp', ip: '127.0.0.1', port: flaky.port}, log);
  const h2 = new CozyLifeMatterLight(api.matter, device2, 'u2', {}, log).accessory.handlers;
  await assert.rejects(h2.colorControl.moveToHueAndSaturationLogic({hue: 85, saturation: 254, transitionTime: 0}));
  fail = false;
  await h2.colorControl.moveToHueLogic({targetHue: 85, isEnhancedHue: false});
  assert.strictEqual(sets(flaky).length, 2, 'the retry as a separate MoveToHue is written');
  flaky.close();
});

test('Matter level 1 never writes brightness 0 to a lit bulb', async () => {
  const {bulb, handlers} = await setup();
  await handlers.levelControl.moveToLevel({level: 1});
  await handlers.levelControl.moveToLevelWithOnOff({level: 2});
  assert.deepStrictEqual(sets(bulb), [{4: 10}, {1: 255, 4: 10}]);
  bulb.close();
});

test('reachable follows the bulb going offline and coming back', async () => {
  let silent = true;
  const answer = statefulBulb({1: 1, 4: 1000});
  const {bulb, api, device} = await setup({reply: request => silent ? null : answer(request)});
  device['client'].timeoutMs = 50;
  await device['poll']();
  await device['poll']();
  await tick();
  await tick();
  assert.deepStrictEqual(api.calls.updates, [
    {uuid: 'matter-uuid', cluster: 'bridgedDeviceBasicInformation', attributes: {reachable: false}},
  ]);
  silent = false;
  await device['poll']();
  await tick();
  await tick();
  assert.ok(api.calls.updates.some(u => u.cluster === 'bridgedDeviceBasicInformation' && u.attributes.reachable === true));
  bulb.close();
});
