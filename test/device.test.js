const {test} = require('node:test');
const assert = require('node:assert');
const {CozyLifeDevice} = require('../dist/device');
const {CozyLifeLight} = require('../dist/light');
const {CozyLifeMatterLight} = require('../dist/matter');
const {fakeBulb, statefulBulb, sets, queries, log, tick, waitFor, fakeApi, FakeAccessory, hap} = require('./helpers');

async function setupViews(bulb, config = {}) {
  const api = fakeApi();
  const device = new CozyLifeDevice({name: 'Lamp', ip: '127.0.0.1', port: bulb.port, ...config}, log);
  const accessory = new FakeAccessory('Lamp', 'hap-uuid');
  new CozyLifeLight(api, accessory, device);
  const matter = new CozyLifeMatterLight(api.matter, device, 'matter-uuid', {}, log);
  api.matter.seed(matter.accessory);
  await matter.whenRegistered();
  await tick();
  api.calls.updates.length = 0;
  const lightbulb = accessory.getService(hap.Service.Lightbulb);
  return {api, device, matter, lightbulb};
}

test('a HomeKit write and a Matter write in the same tick become one device request', async () => {
  const bulb = await fakeBulb({reply: statefulBulb({1: 0, 3: 0, 4: 500, 5: 65535, 6: 65535})});
  const {device, matter, lightbulb} = await setupViews(bulb);
  await Promise.all([
    lightbulb.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(120),
    matter.accessory.handlers.levelControl.moveToLevelWithOnOff({level: 254}),
  ]);
  assert.deepStrictEqual(sets(bulb), [{1: 255, 2: 0, 4: 1000, 5: 120, 6: 0}]);
  assert.strictEqual(bulb.state.maxBusy, 1);
  assert.deepStrictEqual({...device.state}, {on: true, brightness: 100, hue: 120, saturation: 0, mired: 140, mode: 'color'});
  bulb.close();
});

test('polling is shared: one poll per device feeds both HomeKit and Matter', async () => {
  const bulb = await fakeBulb({reply: statefulBulb({1: 1, 3: 260, 4: 500, 5: 240, 6: 500})});
  const {api, device, lightbulb} = await setupViews(bulb);
  try {
    device.start();
    await waitFor(() => api.calls.updates.length > 0);
    await tick();
  } finally {
    device.stop();
  }
  assert.strictEqual(queries(bulb).length, 1);
  assert.strictEqual(bulb.state.maxBusy, 1);
  assert.strictEqual(lightbulb.getCharacteristic(hap.Characteristic.On).value, true);
  assert.strictEqual(lightbulb.getCharacteristic(hap.Characteristic.Brightness).value, 50);
  assert.strictEqual(lightbulb.getCharacteristic(hap.Characteristic.Hue).value, 240);
  assert.strictEqual(lightbulb.getCharacteristic(hap.Characteristic.ColorTemperature).value, 370);
  const pushed = Object.fromEntries(api.calls.updates.map(u => [u.cluster, u.attributes]));
  assert.deepStrictEqual(pushed.onOff, {onOff: true});
  assert.deepStrictEqual(pushed.levelControl, {currentLevel: 128});
  assert.strictEqual(pushed.colorControl.currentHue, 169);
  assert.strictEqual(pushed.colorControl.currentSaturation, 127);
  assert.strictEqual(pushed.colorControl.colorTemperatureMireds, 370);
  assert.strictEqual(pushed.colorControl.colorMode, 0);
  bulb.close();
});

test('HomeKit reads are served from cache and fail once the bulb stops answering polls', async () => {
  const bulb = await fakeBulb({reply: () => null});
  const {device, lightbulb} = await setupViews(bulb, {timeout: 0.05});
  const on = lightbulb.getCharacteristic(hap.Characteristic.On);
  assert.strictEqual(await on.handleGetRequest(), false);
  await device['poll']();
  await device['poll']();
  assert.strictEqual(device.isOnline, false);
  await assert.rejects(on.handleGetRequest());
  assert.strictEqual(queries(bulb).length, 2);
  bulb.close();
});

test('color/white mode follows a bulb that reports hue', async () => {
  const attrs = {1: 1, 3: 500, 4: 1000, 5: 120, 6: 1000};
  const bulb = await fakeBulb({reply: statefulBulb(attrs)});
  const device = new CozyLifeDevice({name: 'Lamp', ip: '127.0.0.1', port: bulb.port}, log);
  await device['poll']();
  assert.strictEqual(device.state.mode, 'color');
  Object.assign(attrs, {5: 65535, 6: 65535}); // switched to white in the CozyLife app
  await device['poll']();
  assert.strictEqual(device.state.mode, 'white');
  bulb.close();
});

test('color/white mode on a bulb that never reports hue (Light-L5): white only when the white value changes', async () => {
  const attrs = {1: 1, 3: 500, 4: 1000, 5: 65535, 6: 65535};
  const bulb = await fakeBulb({reply: statefulBulb(attrs)});
  const device = new CozyLifeDevice({name: 'Lamp', ip: '127.0.0.1', port: bulb.port}, log);
  await device['poll']();
  await device.setColor({hue: 120, saturation: 100});
  Object.assign(attrs, {5: 65535, 6: 65535}); // this bulb reports no hue even in color mode
  await device['poll']();
  assert.strictEqual(device.state.mode, 'color', 'still color after polling');
  attrs[3] = 200; // white temperature set elsewhere
  await device['poll']();
  assert.strictEqual(device.state.mode, 'white');
  bulb.close();
});

test('stop is idempotent and final: no polling or notifications afterwards', async () => {
  const bulb = await fakeBulb({delayMs: 50, reply: statefulBulb({1: 1, 4: 1000})});
  const device = new CozyLifeDevice({name: 'Lamp', ip: '127.0.0.1', port: bulb.port}, log);
  let updates = 0;
  device.onUpdate(() => updates++);
  const write = device.setOn(false);
  await new Promise(resolve => setTimeout(resolve, 120)); // write sent, not answered yet
  device.stop();
  device.stop();
  device.start();
  await write;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.strictEqual(queries(bulb).length, 0);
  assert.strictEqual(updates, 0);
  bulb.close();
});
