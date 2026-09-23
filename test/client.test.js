const {test} = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const {CozyLifeClient} = require('../dist/client');
const {Coalescer} = require('../dist/coalescer');
const mapping = require('../dist/mapping');

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

test('requests are serialized: the device never gets a request before answering the last one', async () => {
  const bulb = await fakeBulb({delayMs: 30});
  const client = new CozyLifeClient('127.0.0.1', bulb.port);
  await Promise.all([client.query([1]), client.set({1: 255}), client.query([1, 2]), client.set({1: 0})]);
  assert.strictEqual(bulb.state.requests.length, 4);
  assert.strictEqual(bulb.state.maxBusy, 1);
  bulb.close();
});

test('set sends cmd 3 with attr list matching the data keys', async () => {
  const bulb = await fakeBulb();
  const client = new CozyLifeClient('127.0.0.1', bulb.port);
  await client.set({1: 255, 2: 0, 5: 120, 6: 1000});
  const [request] = bulb.state.requests;
  assert.strictEqual(request.cmd, 3);
  assert.deepStrictEqual(request.msg, {attr: [1, 2, 5, 6], data: {1: 255, 2: 0, 5: 120, 6: 1000}});
  bulb.close();
});

test('a rejected command (res != 0) is an error, and the queue keeps working', async () => {
  let first = true;
  const bulb = await fakeBulb({reply: r => {
    const res = first ? 1 : 0;
    first = false;
    return {...r, msg: {}, res};
  }});
  const client = new CozyLifeClient('127.0.0.1', bulb.port);
  await assert.rejects(client.set({1: 255}), /rejected/);
  await client.set({1: 0});
  bulb.close();
});

test('a silent device times out instead of hanging', async () => {
  const bulb = await fakeBulb({reply: () => null});
  const client = new CozyLifeClient('127.0.0.1', bulb.port, 200);
  await assert.rejects(client.query([1]), /timeout/);
  bulb.close();
});

test('coalescer merges a burst of HomeKit sets into one write and settles every caller', async () => {
  const writes = [];
  const coalescer = new Coalescer(async data => { writes.push(data); }, 30);
  await Promise.all([
    coalescer.add({1: 255}),
    coalescer.add({2: 0, 5: 120, 6: 500}),
    coalescer.add({2: 0, 5: 120, 6: 1000}),
  ]);
  assert.deepStrictEqual(writes, [{1: 255, 2: 0, 5: 120, 6: 1000}]);
});

test('coalescer propagates a failed write to every caller in the burst', async () => {
  const coalescer = new Coalescer(async () => { throw new Error('boom'); }, 10);
  const results = await Promise.allSettled([coalescer.add({1: 255}), coalescer.add({4: 500})]);
  assert.deepStrictEqual(results.map(r => r.status), ['rejected', 'rejected']);
});

test('scales match the CozyLife integration and round-trip', () => {
  assert.strictEqual(mapping.brightnessToDevice(100), 1000);
  assert.strictEqual(mapping.brightnessFromDevice(1000), 100);
  assert.strictEqual(mapping.saturationToDevice(50), 500);
  assert.strictEqual(mapping.hueToDevice(359.6), 360);
  assert.strictEqual(mapping.miredToDevice(500), 0);
  assert.strictEqual(mapping.miredFromDevice(0), 500);
  for (const mired of [140, 200, 370, 500]) {
    assert.strictEqual(mapping.miredFromDevice(mapping.miredToDevice(mired)), mired);
  }
  assert.strictEqual(mapping.isSet(65535), false);
});
