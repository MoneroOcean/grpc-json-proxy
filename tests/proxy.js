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
