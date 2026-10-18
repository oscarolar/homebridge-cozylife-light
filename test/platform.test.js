const {test} = require('node:test');
const assert = require('node:assert');
const {CozyLifeLightPlatform} = require('../dist/platform');
const {fakeBulb, statefulBulb, queries, log, waitFor, fakeApi, FakeAccessory, hap} = require('./helpers');

const uuid = name => hap.uuid.generate(name);

async function launch(api, lights, cached = {}) {
  const platform = new CozyLifeLightPlatform(log, {platform: 'CozyLifeLight', lights}, api);
  (cached.hap ?? []).forEach(a => platform.configureAccessory(a));
  (cached.matter ?? []).forEach(a => platform.configureMatterAccessory(a));
  api.emit('didFinishLaunching');
  return platform;
}

test('without Matter (Homebridge 1.x) nothing Matter-related is touched', async () => {
  const bulb = await fakeBulb({reply: statefulBulb({1: 1, 4: 500})});
  const api = fakeApi({matter: false});
  // a 1.x API has no isMatterEnabled; any access to api.matter would throw here
  Object.defineProperty(api, 'matter', {get: () => assert.fail('api.matter accessed')});
  await launch(api, [{name: 'Lamp', ip: '127.0.0.1', port: bulb.port}]);
  await waitFor(() => queries(bulb).length === 1);
  assert.strictEqual(api.calls.registered.length, 1);
  assert.strictEqual(api.calls.registered[0].UUID, uuid('cozylife-light:127.0.0.1'));
  api.emit('shutdown');
  bulb.close();
});

test('with Matter disabled on a 2.x bridge nothing Matter-related is registered', async () => {
  const bulb = await fakeBulb({reply: statefulBulb({1: 1, 4: 500})});
  const api = fakeApi();
  api.isMatterEnabled = () => false;
  await launch(api, [{name: 'Lamp', ip: '127.0.0.1', port: bulb.port}]);
  await waitFor(() => queries(bulb).length === 1);
  assert.strictEqual(api.calls.matterRegistered.length, 0);
  assert.strictEqual(api.calls.updates.length, 0);
  api.emit('shutdown');
  bulb.close();
});

test('with Matter enabled each light gets a HAP and a Matter accessory over one device', async () => {
  const bulb = await fakeBulb({reply: statefulBulb({1: 1, 4: 500})});
  const api = fakeApi();
  const cachedHap = new FakeAccessory('Lamp', uuid('cozylife-light:127.0.0.1'));
  const cachedMatter = {UUID: uuid('cozylife-light-matter:127.0.0.1'), displayName: 'Lamp'};
  const staleHap = new FakeAccessory('Old', uuid('cozylife-light:10.0.0.9'));
  const staleMatter = {UUID: uuid('cozylife-light-matter:10.0.0.9'), displayName: 'Old'};
  await launch(api, [{name: 'Lamp', ip: '127.0.0.1', port: bulb.port}],
    {hap: [cachedHap, staleHap], matter: [cachedMatter, staleMatter]});
  await waitFor(() => queries(bulb).length === 1 && api.calls.updates.length > 0);

  assert.strictEqual(api.calls.registered.length, 0, 'cached HAP accessory is reused');
  assert.deepStrictEqual(api.calls.unregistered, [staleHap]);
  // the cached Matter accessory is registered again to attach its handlers
  assert.deepStrictEqual(api.calls.matterRegistered.map(a => a.UUID), [cachedMatter.UUID]);
  assert.deepStrictEqual(api.calls.matterUnregistered, [staleMatter]);
  assert.ok(cachedHap.getService(hap.Service.Lightbulb));
  assert.strictEqual(bulb.state.maxBusy, 1);
  assert.ok(api.calls.updates.every(u => u.uuid === cachedMatter.UUID));
  api.emit('shutdown');
  bulb.close();
});

test('a failing Matter registration does not stop the HomeKit side', async () => {
  const bulb = await fakeBulb({reply: statefulBulb({1: 1, 4: 500})});
  const api = fakeApi();
  api.matter.registerPlatformAccessories = async () => {
    throw new Error('Matter server still starting');
  };
  const errors = [];
  const platform = new CozyLifeLightPlatform({...log, error: message => errors.push(message)},
    {lights: [{name: 'Lamp', ip: '127.0.0.1', port: bulb.port}]}, api);
  platform.configureAccessory(new FakeAccessory('Lamp', uuid('cozylife-light:127.0.0.1')));
  api.emit('didFinishLaunching');
  await waitFor(() => queries(bulb).length === 1);
  assert.match(errors[0], /Matter registration failed/);
  api.emit('shutdown');
  bulb.close();
});

test('a hung Matter registration does not delay HomeKit polling', async () => {
  const bulb = await fakeBulb({reply: statefulBulb({1: 1, 4: 500})});
  const api = fakeApi();
  api.matter.registerPlatformAccessories = () => new Promise(() => undefined);
  await launch(api, [{name: 'Lamp', ip: '127.0.0.1', port: bulb.port}],
    {hap: [new FakeAccessory('Lamp', uuid('cozylife-light:127.0.0.1'))]});
  await waitFor(() => queries(bulb).length === 1);
  api.emit('shutdown');
  bulb.close();
});
