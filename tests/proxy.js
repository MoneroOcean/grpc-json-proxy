import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { createProxy, parseArgs } from '../grpc-json-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureProto = path.join(__dirname, 'mock.proto');

describe('argument parsing', () => {
  it('keeps the original positional usage and parses modern options', () => {
    const options = parseArgs([
      fixtureProto,
      '18144',
      '18142',
      '--bind',
      '0.0.0.0',
      '--grpc-host',
      'localhost',
      '--status-interval',
      '5s',
      '--max-body-bytes',
      '2048',
      '--quiet',
    ]);

    assert.equal(options.protoFile, fixtureProto);
    assert.equal(options.restPort, 18144);
    assert.equal(options.grpcPort, 18142);
    assert.equal(options.bind, '0.0.0.0');
    assert.equal(options.grpcHost, 'localhost');
    assert.equal(options.statusIntervalMs, 5000);
    assert.equal(options.maxBodyBytes, 2048);
    assert.equal(options.quiet, true);
  });
});

describe('JSON-RPC proxy', () => {
  let grpcServer;
  let grpcPort;
  let proxy;
  let baseUrl;
  let logs;

  beforeEach(async () => {
    logs = [];
    ({ server: grpcServer, port: grpcPort } = await startMockGrpcServer());
    proxy = createProxy({
      protoFile: fixtureProto,
      restPort: 0,
      grpcPort,
      grpcHost: '127.0.0.1',
      bind: '127.0.0.1',
      service: 'test.rpc.MockService',
      statusIntervalMs: 30_000,
      maxBodyBytes: 512,
      quiet: true,
      verbose: false,
      logger: testLogger(logs),
    });
    await proxy.start();
    const address = proxy.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = undefined;
    }
    if (grpcServer) {
      await new Promise((resolve) => grpcServer.tryShutdown(resolve));
      grpcServer = undefined;
    }
  });

  it('proxies unary calls and accepts id 0', async () => {
    const response = await postJson({
      jsonrpc: '2.0',
      id: 0,
      method: 'Echo',
      params: { message: 'hello' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      jsonrpc: '2.0',
      result: { message: 'hello' },
      id: 0,
    });
  });

  it('proxies server-streaming calls as arrays', async () => {
    const response = await postJson({
      jsonrpc: '2.0',
      id: 'stream',
      method: 'ListItems',
      params: { count: 3 },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      jsonrpc: '2.0',
      result: [
        { index: 0, label: 'item-0' },
        { index: 1, label: 'item-1' },
        { index: 2, label: 'item-2' },
      ],
      id: 'stream',
    });
  });

  it('returns parse errors for malformed JSON', async () => {
    const response = await postRaw('{not json');

    assert.equal(response.status, 400);
    assert.equal(response.body.jsonrpc, '2.0');
    assert.equal(response.body.error.code, -32700);
    assert.equal(response.body.id, null);
  });

  it('returns invalid request when id is missing', async () => {
    const response = await postJson({
      jsonrpc: '2.0',
      method: 'Echo',
      params: { message: 'hello' },
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, -32600);
  });

  it('returns method not found for unknown methods', async () => {
    const response = await postJson({
      jsonrpc: '2.0',
      id: 'missing',
      method: 'DoesNotExist',
      params: {},
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, -32601);
  });

  it('rejects oversized request bodies', async () => {
    const response = await postRaw(JSON.stringify({
      jsonrpc: '2.0',
      id: 'large',
      method: 'Echo',
      params: { message: 'x'.repeat(1000) },
    }));

    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, -32603);
  });

  it('survives a post-startup server error instead of crashing', () => {
    const before = proxy.metrics.error;
    // With the previous code the only 'error' listener was removed after listen(),
    // so this emit would be rethrown by EventEmitter and terminate the process.
    assert.doesNotThrow(() => {
      proxy.server.emit('error', Object.assign(new Error('synthetic accept failure'), { code: 'EMFILE' }));
    });
    assert.equal(proxy.metrics.error, before + 1);
    assert.equal(logs.filter((line) => line.type === 'error' && line.scope === 'server').length, 1);
  });

  it('does not accumulate error listeners across restart cycles', async () => {
    for (let i = 0; i < 3; i += 1) {
      await proxy.stop();
      await proxy.start();
    }
    // Exactly one persistent listener regardless of how many start()/stop() cycles ran.
    assert.equal(proxy.server.listenerCount('error'), 1);
    const before = proxy.metrics.error;
    proxy.server.emit('error', Object.assign(new Error('one'), { code: 'EMFILE' }));
    // A single error event is logged/counted once, not once per past start().
    assert.equal(proxy.metrics.error, before + 1);
  });

  it('deduplicates repeated gRPC errors', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'fail',
      method: 'Fail',
      params: { message: 'bad' },
    };

    const first = await postJson(request);
    const second = await postJson({ ...request, id: 'fail-2' });

    assert.equal(first.status, 502);
    assert.equal(second.status, 502);
    assert.equal(logs.filter((line) => line.type === 'error').length, 1);
  });

  async function postJson(payload) {
    return postRaw(JSON.stringify(payload));
  }

  async function postRaw(body) {
    const response = await fetch(`${baseUrl}/json_rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }
});

describe('ambiguous method dispatch', () => {
  let grpcServer;
  let grpcPort;
  let proxy;
  let baseUrl;

  beforeEach(async () => {
    ({ server: grpcServer, port: grpcPort } = await startMockGrpcServer());
    proxy = createProxy({
      protoFile: fixtureProto,
      restPort: 0,
      grpcPort,
      grpcHost: '127.0.0.1',
      bind: '127.0.0.1',
      statusIntervalMs: 30_000,
      maxBodyBytes: 512,
      quiet: true,
      verbose: false,
      logger: testLogger([]),
    });
    await proxy.start();
    const address = proxy.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = undefined;
    }
    if (grpcServer) {
      await new Promise((resolve) => grpcServer.tryShutdown(resolve));
      grpcServer = undefined;
    }
  });

  it('rejects ambiguous bare method names and accepts fully qualified names', async () => {
    const ambiguous = await postJson({
      jsonrpc: '2.0',
      id: 'ambiguous',
      method: 'Echo',
      params: { message: 'hello' },
    });
    assert.equal(ambiguous.status, 400);
    assert.equal(ambiguous.body.error.message, 'Ambiguous method name');

    const qualified = await postJson({
      jsonrpc: '2.0',
      id: 'qualified',
      method: 'test.rpc.MockService.Echo',
      params: { message: 'hello' },
    });
    assert.equal(qualified.status, 200);
    assert.deepEqual(qualified.body.result, { message: 'hello' });
  });

  async function postJson(payload) {
    const response = await fetch(`${baseUrl}/json_rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }
});

describe('resource limits', () => {
  let grpcServer;
  let grpcPort;

  beforeEach(async () => {
    ({ server: grpcServer, port: grpcPort } = await startMockGrpcServer());
  });

  afterEach(async () => {
    if (grpcServer) {
      await new Promise((resolve) => grpcServer.tryShutdown(resolve));
      grpcServer = undefined;
    }
  });

  async function withProxy(overrides, fn) {
    const proxy = createProxy({
      protoFile: fixtureProto,
      restPort: 0,
      grpcPort,
      grpcHost: '127.0.0.1',
      bind: '127.0.0.1',
      service: 'test.rpc.MockService',
      statusIntervalMs: 30_000,
      maxBodyBytes: 4096,
      quiet: true,
      verbose: false,
      logger: testLogger([]),
      ...overrides,
    });
    await proxy.start();
    const baseUrl = `http://127.0.0.1:${proxy.server.address().port}`;
    try {
      return await fn(baseUrl);
    } finally {
      await proxy.stop();
    }
  }

  async function post(baseUrl, payload) {
    const response = await fetch(`${baseUrl}/json_rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }

  it('aborts a hung upstream call once the deadline passes', async () => {
    await withProxy({ callTimeoutMs: 100 }, async (baseUrl) => {
      const response = await post(baseUrl, { jsonrpc: '2.0', id: 'hang', method: 'Hang', params: {} });
      assert.ok(response.status >= 400);
      assert.ok(response.body.error);
    });
  });

  it('caps the number of buffered server-stream rows', async () => {
    await withProxy({ maxResponseRows: 2 }, async (baseUrl) => {
      const response = await post(baseUrl, { jsonrpc: '2.0', id: 'big', method: 'ListItems', params: { count: 5 } });
      assert.ok(response.status >= 400);
      const detail = response.body.error?.data ?? response.body.error?.message ?? '';
      assert.match(detail, /exceeded 2 rows/);
    });
  });

  it('enforces the configured gRPC receive message limit', async () => {
    // Tiny request (passes the send limit) but a large response (Big returns
    // ~8 KiB), so the bound is tripped specifically on the receive path.
    await withProxy({ maxRecvBytes: 1024 }, async (baseUrl) => {
      const response = await post(baseUrl, { jsonrpc: '2.0', id: 'big-msg', method: 'Big', params: {} });
      assert.ok(response.status >= 400);
      assert.ok(response.body.error);
    });
  });
});

describe('vendored Tari protos', () => {
  for (const proto of ['base_node.proto', 'wallet.proto']) {
    it(`loads ${proto}`, () => {
      const definition = protoLoader.loadSync(path.join(__dirname, '..', proto), {
        keepCase: true,
        longs: String,
        bytes: Array,
        defaults: true,
        includeDirs: [path.join(__dirname, '..')],
      });
      assert.ok(Object.keys(definition).some((key) => key.startsWith('tari.rpc.')));
    });
  }
});

async function startMockGrpcServer() {
  const packageDefinition = protoLoader.loadSync(fixtureProto, {
    keepCase: true,
    longs: String,
    bytes: Array,
    defaults: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition).test.rpc;
  const server = new grpc.Server();

  server.addService(proto.MockService.service, {
    Echo(call, callback) {
      callback(null, { message: call.request.message });
    },
    ListItems(call) {
      const count = Number(call.request.count ?? 0);
      for (let index = 0; index < count; index += 1) {
        call.write({ index, label: `item-${index}` });
      }
      call.end();
    },
    Fail(call, callback) {
      callback({
        code: grpc.status.UNAVAILABLE,
        details: 'mock unavailable',
      });
    },
    Hang() {
      // Intentionally never invoke the callback: simulates a hung-but-silent
      // upstream so the per-call deadline can be exercised.
    },
    Big(call, callback) {
      // Large response to a tiny request: lets a test trip the receive-message
      // limit (on the response) without first hitting the send limit (request).
      callback(null, { message: 'x'.repeat(8192) });
    },
  });

  server.addService(proto.OtherService.service, {
    Echo(call, callback) {
      callback(null, { message: `other:${call.request.message}` });
    },
  });

  const port = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) {
        reject(error);
      } else {
        resolve(boundPort);
      }
    });
  });

  return { server, port };
}

function testLogger(logs) {
  return {
    start(message) {
      logs.push({ type: 'start', message });
    },
    startStatus() {},
    stopStatus() {},
    error(scope, error) {
      const message = error?.details || error?.message || String(error);
      const key = `${scope}:${message}`;
      if (logs.some((line) => line.key === key)) {
        return;
      }
      logs.push({ type: 'error', key, scope, message });
    },
  };
}
