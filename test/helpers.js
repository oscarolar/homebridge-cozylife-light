const net = require('node:net');
const hap = require('@homebridge/hap-nodejs');

// Fake CozyLife bulb: answers each JSON line after `delayMs`, records every
// request and the highest number of requests being handled at the same time
// (received but not yet answered).
function fakeBulb({delayMs = 20, reply} = {}) {
  const state = {requests: [], busy: 0, maxBusy: 0};
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('data', data => {
      const request = JSON.parse(data.toString().trim());
      state.requests.push(request);
      state.busy++;
      state.maxBusy = Math.max(state.maxBusy, state.busy);
      const response = reply ? reply(request) : {...request, msg: {attr: [1], data: {1: 1}}, res: 0};
      if (response === null) {
        return; // never answer
      }
      setTimeout(() => {
        state.busy--;
        socket.write(JSON.stringify(response) + '\n');
      }, delayMs);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({state, port: server.address().port, close: () => {
      sockets.forEach(s => s.destroy());
      server.close();
    }})));
}

// Reply function for a bulb that keeps its attributes: writes change them,
// queries return them.
function statefulBulb(attrs) {
  return request => {
    if (request.cmd === 3) {
      Object.assign(attrs, request.msg.data);
    }
    const data = request.cmd === 2 ? {...attrs} : {};
    return {...request, msg: {attr: Object.keys(attrs).map(Number), data}, res: 0};
  };
}

const sets = bulb => bulb.state.requests.filter(r => r.cmd === 3).map(r => r.msg.data);
const queries = bulb => bulb.state.requests.filter(r => r.cmd === 2);

const log = {debug() {}, info() {}, warn() {}, error() {}};

const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(condition, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class FakeAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.context = {};
    this.services = [new hap.Service.AccessoryInformation()];
  }

  getService(type) {
    return this.services.find(s => s.UUID === type.UUID);
  }

  addService(type, name) {
    const service = new type(name);
    this.services.push(service);
    return service;
  }
}

// Homebridge API stand-in. `matter: true` mimics a 2.x bridge with Matter
// enabled; `matter: false` a 1.x one (no isMatterEnabled, no api.matter).
function fakeApi({matter = true} = {}) {
  const calls = {registered: [], unregistered: [], matterRegistered: [], matterUnregistered: [], updates: []};
  const listeners = {};
  const api = {
    hap,
    calls,
    platformAccessory: FakeAccessory,
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return api;
    },
    emit(event) {
      (listeners[event] ?? []).forEach(listener => listener());
    },
    registerPlatformAccessories: (plugin, platform, accessories) => calls.registered.push(...accessories),
    unregisterPlatformAccessories: (plugin, platform, accessories) => calls.unregistered.push(...accessories),
  };
  if (matter) {
    class Failure extends Error {}
    // Endpoint state per accessory, as Homebridge would hold it.
    const states = calls.states = {};
    const endpoint = uuid => states[uuid] ??= {};
    api.isMatterEnabled = () => true;
    api.matter = {
      deviceTypes: {ExtendedColorLight: {name: 'ExtendedColorLight'}, ColorTemperatureLight: {name: 'ColorTemperatureLight'}},
      types: {
        ColorControl: {ColorMode: {CurrentHueAndCurrentSaturation: 0, CurrentXAndCurrentY: 1, ColorTemperatureMireds: 2}},
        LevelControl: {StepMode: {Up: 0, Down: 1}},
      },
      status: {Failure},
      registerPlatformAccessories: async (plugin, platform, accessories) => {
        calls.matterRegistered.push(...accessories);
        accessories.forEach(a => api.matter.seed(a));
      },
      unregisterPlatformAccessories: async (plugin, platform, accessories) => {
        calls.matterUnregistered.push(...accessories);
      },
      getAccessoryState: async (uuid, cluster) => ({...endpoint(uuid)[cluster]}),
      updateAccessoryState: async (uuid, cluster, attributes) => {
        calls.updates.push({uuid, cluster, attributes});
        Object.assign(endpoint(uuid)[cluster] ??= {}, attributes);
      },
      // test helpers: what registration creates, and matter.js changing it
      seed: accessory => {
        const state = endpoint(accessory.UUID);
        for (const [cluster, attributes] of Object.entries(accessory.clusters)) {
          state[cluster] = {...attributes};
        }
        state.bridgedDeviceBasicInformation = {reachable: true};
      },
      commit: (uuid, cluster, attributes) => Object.assign(endpoint(uuid)[cluster] ??= {}, attributes),
    };
  }
  return api;
}

module.exports = {fakeBulb, statefulBulb, sets, queries, log, tick, waitFor, fakeApi, FakeAccessory, hap};
