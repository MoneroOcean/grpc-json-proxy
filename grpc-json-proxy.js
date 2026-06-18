#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const DEFAULT_BIND = '0.0.0.0';
const DEFAULT_GRPC_HOST = '127.0.0.1';
const DEFAULT_STATUS_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;          // per-call gRPC deadline; 0 disables
const DEFAULT_MAX_RECV_BYTES = 67_108_864;       // 64 MiB grpc.max_receive_message_length
const DEFAULT_MAX_RESPONSE_ROWS = 1_000_000;     // cap on buffered server-stream rows; 0 = unlimited
const SHUTDOWN_GRACE_MS = 10_000;                // max wait for in-flight requests to drain on SIGTERM/SIGINT
const JSON_CONTENT_TYPE = { 'Content-Type': 'application/json' };

const JSON_RPC_ERRORS = {
  parseError: { code: -32700, message: 'Parse error' },
  invalidRequest: { code: -32600, message: 'Invalid Request' },
  methodNotFound: { code: -32601, message: 'Method not found' },
  internalError: { code: -32603, message: 'Internal error' },
};

export function parseArgs(argv) {
  const options = {
    bind: DEFAULT_BIND,
    grpcHost: DEFAULT_GRPC_HOST,
    statusIntervalMs: DEFAULT_STATUS_INTERVAL_MS,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    maxRecvBytes: DEFAULT_MAX_RECV_BYTES,
    maxResponseRows: DEFAULT_MAX_RESPONSE_ROWS,
    quiet: false,
    verbose: false,
    timestamps: false,
    service: undefined,
    help: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[i];
    };

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--bind') {
      options.bind = next();
    } else if (arg === '--grpc-host') {
      options.grpcHost = next();
    } else if (arg === '--grpc-port') {
      options.grpcPort = next();
    } else if (arg === '--service') {
      options.service = next();
    } else if (arg === '--status-interval') {
      options.statusIntervalMs = parseDuration(next());
    } else if (arg === '--max-body-bytes') {
      options.maxBodyBytes = parsePositiveInteger(next(), '--max-body-bytes');
    } else if (arg === '--call-timeout') {
      options.callTimeoutMs = parseDuration(next(), '--call-timeout', { allowZero: true });
    } else if (arg === '--max-recv-bytes') {
      options.maxRecvBytes = parsePositiveInteger(next(), '--max-recv-bytes');
    } else if (arg === '--max-response-rows') {
      options.maxResponseRows = parseNonNegativeInteger(next(), '--max-response-rows');
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--timestamps') {
      options.timestamps = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (options.help) {
    return { ...options, positional };
  }

  if (positional.length < 3) {
    throw new Error('Expected <proto> <restPort> <grpcPort>');
  }

  const [protoFile, restPort, grpcPort] = positional;
  return {
    ...options,
    protoFile,
    restPort: parsePort(restPort, 'REST port'),
    grpcPort: parsePort(options.grpcPort ?? grpcPort, 'gRPC port'),
    positional,
  };
}

export function helpText() {
  return [
    'Usage:',
    '  node grpc-json-proxy.js <proto> <restPort> <grpcPort> [options]',
    '',
    'Options:',
    `  --bind <host>             REST bind address (default: ${DEFAULT_BIND})`,
    `  --grpc-host <host>        gRPC target host (default: ${DEFAULT_GRPC_HOST})`,
    '  --grpc-port <port>        Override positional gRPC port',
    '  --service <name>          Expose one service, for example tari.rpc.BaseNode',
    '  --status-interval <ms|s>  Status line interval (default: 30s)',
    `  --max-body-bytes <bytes>  Maximum JSON body size (default: ${DEFAULT_MAX_BODY_BYTES})`,
    `  --call-timeout <ms|s>     Per-call gRPC deadline, 0 disables (default: ${DEFAULT_CALL_TIMEOUT_MS}ms)`,
    `  --max-recv-bytes <bytes>  Max gRPC receive message size (default: ${DEFAULT_MAX_RECV_BYTES})`,
    `  --max-response-rows <n>   Max buffered server-stream rows, 0=unlimited (default: ${DEFAULT_MAX_RESPONSE_ROWS})`,
    '  --quiet                   Disable periodic status lines',
    '  --verbose                 Print full error stacks',
    '  --timestamps              Prefix proxy log lines with ISO timestamps',
    '  --help                    Show this help',
  ].join('\n');
}

export function createProxy(options) {
  const logger = options.logger ?? createLogger({
    quiet: options.quiet,
    verbose: options.verbose,
    timestamps: options.timestamps,
    statusIntervalMs: options.statusIntervalMs,
  });
  const metrics = createMetrics();
  const registry = buildServiceRegistry(options);
  metrics.label = `rest=${options.bind}:${options.restPort}`;

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, { ...options, logger, metrics, registry }).catch((error) => {
      metrics.error += 1;
      if (logger.error('request', error) === false) {
        metrics.repeatedErrors += 1;
      }
      sendJsonRpcError(res, 500, null, JSON_RPC_ERRORS.internalError);
    });
  });

  // A single 'error' listener for the server's whole lifetime, registered once
  // here (not per start()) so repeated start()/stop() cycles never accumulate
  // listeners or multiply error logging. While a start() is in flight it rejects
  // that start() promise; otherwise it logs and counts the error instead of
  // letting Node rethrow it as an uncaught exception that would kill the
  // long-running proxy on transient conditions (e.g. accept-time EMFILE/ENFILE
  // under file-descriptor pressure).
  let starting = false;
  let rejectStart = null;
  server.on('error', (error) => {
    if (starting && rejectStart) {
      const reject = rejectStart;
      starting = false;
      rejectStart = null;
      reject(error);
      return;
    }
    metrics.error += 1;
    if (logger.error('server', error) === false) {
      metrics.repeatedErrors += 1;
    }
  });

  return {
    server,
    logger,
    metrics,
    registry,
    start() {
      return new Promise((resolve, reject) => {
        starting = true;
        rejectStart = reject;
        server.listen(options.restPort, options.bind, () => {
          starting = false;
          rejectStart = null;
          logger.start(registry.summary(options));
          logger.startStatus(metrics);
          resolve(server);
        });
      });
    },
    stop() {
      logger.stopStatus();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // server.close() only invokes its callback once every connection has
        // drained, so idle keep-alive connections (no in-flight request) would
        // otherwise keep stop() pending indefinitely. Drop them immediately;
        // this does not abort connections that still have a request in flight.
        server.closeIdleConnections?.();
      });
    },
  };
}

function buildServiceRegistry(options) {
  const protoPath = path.resolve(options.protoFile);
  const protoDir = path.dirname(protoPath);

  // includeDirs makes local imports such as "types.proto" stable even when the
  // process is started outside the repository directory.
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    bytes: Array,
    defaults: true,
    includeDirs: [protoDir],
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition);
  const entryServices = getServicesDeclaredInEntryProto(protoPath);
  const discovered = discoverServices(loaded);
  const selected = selectServices(discovered, entryServices, options.service);

  if (selected.length === 0) {
    throw new Error(`No gRPC services found in ${options.protoFile}`);
  }

  const clients = new Map();
  const methodsByName = new Map();
  const methodsByQualifiedName = new Map();
  const target = `${options.grpcHost}:${options.grpcPort}`;
  // Raise the gRPC message size cap above the 4 MB @grpc/grpc-js default so large
  // upstream responses (e.g. Tari GetBlocks over a wide height range) don't fail
  // with RESOURCE_EXHAUSTED. Still bounded (not -1) so a single message can't grow
  // without limit; the per-stream row cap bounds the count of buffered messages.
  const maxRecvBytes = options.maxRecvBytes ?? DEFAULT_MAX_RECV_BYTES;

  for (const service of selected) {
    const client = new service.ctor(target, grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': maxRecvBytes,
      'grpc.max_send_message_length': maxRecvBytes,
    });
    clients.set(service.name, client);

    for (const [methodName, definition] of Object.entries(service.ctor.service)) {
      const descriptor = {
        name: methodName,
        qualifiedName: `${service.name}.${methodName}`,
        serviceName: service.name,
        client,
        definition,
      };
      pushMapList(methodsByName, methodName, descriptor);
      methodsByQualifiedName.set(descriptor.qualifiedName, descriptor);
    }
  }

  return {
    services: selected,
    methodsByName,
    methodsByQualifiedName,
    resolve(methodName) {
      if (methodsByQualifiedName.has(methodName)) {
        return { descriptor: methodsByQualifiedName.get(methodName) };
      }

      const matches = methodsByName.get(methodName) ?? [];
      if (matches.length === 1) {
        return { descriptor: matches[0] };
      }
      if (matches.length > 1) {
        return {
          error: {
            code: -32600,
            message: 'Ambiguous method name',
            data: {
              method: methodName,
              matches: matches.map((match) => match.qualifiedName),
            },
          },
        };
      }
      return { error: { ...JSON_RPC_ERRORS.methodNotFound, data: { method: methodName } } };
    },
    summary(config) {
      const methodCount = methodsByQualifiedName.size;
      return `proxy listening rest=${config.bind}:${config.restPort} grpc=${target} proto=${path.basename(config.protoFile)} services=${selected.map((service) => service.name).join(',')} methods=${methodCount}`;
    },
  };
}

function getServicesDeclaredInEntryProto(protoPath) {
  const text = fs.readFileSync(protoPath, 'utf8');
  const packageName = text.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m)?.[1];
  const services = [...text.matchAll(/^\s*service\s+([A-Za-z0-9_]+)\s*\{/gm)].map((match) => {
    return packageName ? `${packageName}.${match[1]}` : match[1];
  });
  return services;
}

function discoverServices(root, prefix = '') {
  const services = [];
  for (const [name, value] of Object.entries(root)) {
    const qualifiedName = prefix ? `${prefix}.${name}` : name;
    if (typeof value === 'function' && value.service) {
      services.push({ name: qualifiedName, ctor: value });
    } else if (value && typeof value === 'object' && !value.type) {
      services.push(...discoverServices(value, qualifiedName));
    }
  }
  return services;
}

function selectServices(discovered, entryServices, requestedService) {
  if (requestedService) {
    const exact = discovered.find((service) => service.name === requestedService);
    if (!exact) {
      throw new Error(`Requested service not found: ${requestedService}`);
    }
    return [exact];
  }

  // Imported protos can pull in additional services. Exposing only services
  // declared by the entry proto avoids accidentally proxying imported APIs.
  const allowed = new Set(entryServices);
  const selected = discovered.filter((service) => allowed.has(service.name));
  return selected.length > 0 ? selected : discovered;
}

async function handleHttpRequest(req, res, context) {
  if (req.method !== 'POST' || req.url !== '/json_rpc') {
    sendJsonRpcError(res, 404, null, { code: -32004, message: 'Endpoint not found' });
    return;
  }

  let body;
  try {
    body = await readBody(req, context.maxBodyBytes);
  } catch (error) {
    context.metrics.error += 1;
    logError(context, 'request', error);
    sendJsonRpcError(res, grpcErrorStatus(error), null, {
      ...JSON_RPC_ERRORS.internalError,
      data: normalizeErrorMessage(error),
    });
    return;
  }
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    context.metrics.error += 1;
    sendJsonRpcError(res, 400, null, JSON_RPC_ERRORS.parseError);
    return;
  }

  const invalid = validateJsonRpcRequest(request);
  if (invalid) {
    context.metrics.error += 1;
    sendJsonRpcError(res, 400, request?.id ?? null, invalid);
    return;
  }

  context.metrics.active += 1;
  try {
    const { descriptor, error } = context.registry.resolve(request.method);
    if (error) {
      context.metrics.error += 1;
      sendJsonRpcError(res, error.code === -32601 ? 404 : 400, request.id, error);
      return;
    }

    const result = await callGrpcMethod(descriptor, request.params ?? {}, {
      callTimeoutMs: context.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      maxResponseRows: context.maxResponseRows ?? DEFAULT_MAX_RESPONSE_ROWS,
    });
    context.metrics.ok += 1;
    sendJsonRpcResult(res, request.id, result);
  } catch (error) {
    context.metrics.error += 1;
    logError(context, request.method, error);
    sendJsonRpcError(res, grpcErrorStatus(error), request.id, {
      ...JSON_RPC_ERRORS.internalError,
      data: normalizeErrorMessage(error),
    });
  } finally {
    context.metrics.active -= 1;
  }
}

function logError(context, scope, error) {
  if (context.logger.error(scope, error) === false) {
    context.metrics.repeatedErrors += 1;
  }
}

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }
      size += Buffer.byteLength(chunk);
      if (size > maxBodyBytes) {
        tooLarge = true;
        reject(Object.assign(new Error(`Request body too large: ${size} bytes`), { httpStatus: 413 }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!tooLarge) {
        resolve(body);
      }
    });
    req.on('error', reject);
  });
}

function validateJsonRpcRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return JSON_RPC_ERRORS.invalidRequest;
  }
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.method.length === 0) {
    return JSON_RPC_ERRORS.invalidRequest;
  }
  if (!Object.hasOwn(request, 'id')) {
    return { ...JSON_RPC_ERRORS.invalidRequest, data: 'Request id is required' };
  }
  if (request.params !== undefined && request.params !== null && (typeof request.params !== 'object' || Array.isArray(request.params))) {
    return { ...JSON_RPC_ERRORS.invalidRequest, data: 'params must be a JSON object when provided' };
  }
  return null;
}

// A gRPC call option that bounds total call duration, so a hung-but-silent
// upstream (never sends a response or 'end') can't wedge the HTTP request
// forever and leak the active-request counter / HTTP socket. 0 disables it.
function callDeadline(callTimeoutMs) {
  return callTimeoutMs > 0 ? { deadline: Date.now() + callTimeoutMs } : {};
}

function callGrpcMethod(descriptor, params, limits) {
  const { definition, client, name } = descriptor;
  if (definition.requestStream) {
    return Promise.reject(new Error(`Client-streaming method is not supported: ${descriptor.qualifiedName}`));
  }

  // @grpc/proto-loader exposes stream metadata on the method definition. We
  // must branch here because callback-style unary calls and EventEmitter-style
  // server streams cannot be safely handled by the same control flow.
  if (definition.responseStream) {
    return callServerStreaming(client, name, params, limits);
  }
  return callUnary(client, name, params, limits);
}

function callUnary(client, methodName, params, limits) {
  return new Promise((resolve, reject) => {
    client[methodName](params, new grpc.Metadata(), callDeadline(limits.callTimeoutMs), (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response);
      }
    });
  });
}

function callServerStreaming(client, methodName, params, limits) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const stream = client[methodName](params, new grpc.Metadata(), callDeadline(limits.callTimeoutMs));
    stream.on('data', (data) => {
      // Bound the number of buffered rows so a large/broad stream (potentially
      // attacker-driven, since the endpoint is unauthenticated) can't grow the
      // response array until the process runs out of memory.
      if (limits.maxResponseRows > 0 && rows.length >= limits.maxResponseRows) {
        stream.cancel();
        reject(new Error(`Server-streaming response exceeded ${limits.maxResponseRows} rows`));
        return;
      }
      rows.push(data);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(rows));
  });
}

function sendJsonRpcResult(res, id, result) {
  sendJson(res, 200, { jsonrpc: '2.0', result, id });
}

function sendJsonRpcError(res, status, id, error) {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
    id,
  });
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, JSON_CONTENT_TYPE);
  res.end(`${JSON.stringify(payload)}\n`);
}

export function createMetrics() {
  return {
    ok: 0,
    error: 0,
    active: 0,
    startTime: Date.now(),
    lastOk: 0,
    lastError: 0,
    repeatedErrors: 0,
  };
}

export function createLogger({ quiet = false, verbose = false, timestamps = false, statusIntervalMs = DEFAULT_STATUS_INTERVAL_MS } = {}) {
  let statusTimer;
  const seenErrors = new Map();
  const format = (message) => (timestamps ? `${timestamp()} ${message}` : message);

  return {
    start(message) {
      console.log(format(message));
    },
    startStatus(metrics) {
      if (quiet || statusIntervalMs <= 0) {
        return;
      }
      statusTimer = setInterval(() => {
        const ok = metrics.ok - metrics.lastOk;
        const error = metrics.error - metrics.lastError;
        const total = ok + error;
        metrics.lastOk = metrics.ok;
        metrics.lastError = metrics.error;
        const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
        const repeated = metrics.repeatedErrors > 0 ? ` repeated_errors=${metrics.repeatedErrors}` : '';
        const label = metrics.label ? ` ${metrics.label}` : '';
        console.log(format(`processed${label} ok=${ok} error=${error} total=${total} active=${metrics.active} uptime=${uptime}s${repeated}`));
        metrics.repeatedErrors = 0;
      }, statusIntervalMs);
      statusTimer.unref?.();
    },
    stopStatus() {
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = undefined;
      }
    },
    error(scope, error) {
      const message = normalizeErrorMessage(error);
      const key = `${scope}:${message}`;
      const count = seenErrors.get(key) ?? 0;
      seenErrors.set(key, count + 1);
      if (count > 0) {
        return false;
      }
      const line = format(`error method=${scope} message=${JSON.stringify(message)}`);
      console.error(verbose && error?.stack ? `${line}\n${error.stack}` : line);
      return true;
    },
  };
}

function normalizeErrorMessage(error) {
  if (!error) {
    return 'Unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  return error.details || error.message || String(error);
}

function grpcErrorStatus(error) {
  if (Number.isInteger(error?.httpStatus)) {
    return error.httpStatus;
  }
  return 502;
}

function pushMapList(map, key, value) {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function parsePort(value, label) {
  const port = parsePositiveInteger(value, label);
  if (port > 65_535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseDuration(value, label = '--status-interval', { allowZero = false } = {}) {
  const toInt = allowZero ? parseNonNegativeInteger : parsePositiveInteger;
  if (typeof value === 'string' && value.endsWith('s')) {
    return toInt(value.slice(0, -1), label) * 1000;
  }
  return toInt(value, label);
}

function timestamp() {
  return new Date().toISOString();
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
      return;
    }
    const proxy = createProxy(options);
    await proxy.start();

    const shutdown = async () => {
      // server.close() (inside stop()) only resolves once every connection has
      // drained; a request stuck on a slow/hung upstream (e.g. with
      // --call-timeout 0) would otherwise leave this handler awaiting forever
      // and the proxy unkillable by a process manager. Cap the wait so the
      // process always terminates on SIGTERM/SIGINT.
      const forceExit = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
      forceExit.unref?.();
      try {
        await proxy.stop();
      } catch {
        // Best-effort shutdown: fall through to exit regardless of close errors.
      }
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(`${timestamp()} error message=${JSON.stringify(normalizeErrorMessage(error))}`);
    console.error(helpText());
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
