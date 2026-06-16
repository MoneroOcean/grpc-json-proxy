<div align="center">

# grpc-json-proxy

gRPC ↔ JSON-RPC 2.0 HTTP proxy for Tari base node and wallet protos, with quiet daemon-style status output.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD--3--Clause-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.9-brightgreen.svg" alt="Node >=22.9">
  <img src="https://img.shields.io/badge/language-JavaScript-lightgrey.svg" alt="JavaScript">
  <img src="https://img.shields.io/badge/proxy-gRPC%E2%86%94JSON--RPC-0a7ea4.svg" alt="gRPC to JSON-RPC proxy">
  <a href="https://github.com/MoneroOcean"><img src="https://img.shields.io/badge/MoneroOcean-ecosystem-6f42c1.svg" alt="MoneroOcean"></a>
</p>

</div>

## Overview

`grpc-json-proxy` exposes gRPC unary and server-streaming methods as a small
JSON-RPC 2.0 HTTP endpoint. It is intended for the [Tari](https://www.tari.com/)
base node and wallet gRPC protos, but it can proxy any compatible proto with
unary or server-streaming methods.

The proxy is quiet by default: it prints one startup line, one periodic status
line, and concise error summaries without stack traces. This makes it well
suited to running as a long-lived service alongside a Tari daemon — for example
to feed JSON-RPC-speaking tooling such as [nodejs-pool](https://github.com/MoneroOcean/nodejs-pool).

## Features

- Single-file, dependency-light proxy ([grpc-json-proxy.js](grpc-json-proxy.js)).
- Maps gRPC unary and server-streaming methods to JSON-RPC 2.0 over HTTP.
- Server-streaming responses are collected and returned as JSON arrays.
- Vendored Tari base node and wallet protos, ready to expose.
- Quiet by default: one startup line, periodic status lines, one-line error
  summaries; repeated errors are deduplicated and counted.
- Configurable bind/target hosts, status interval, body-size limit, and logging
  verbosity via command-line flags.
- Bare or fully qualified method names, with optional single-service exposure.

## Requirements

- Node.js 22.9.0 or newer (see `engines` in [package.json](package.json)).
- A gRPC service matching the proto you expose.

Install dependencies:

```sh
npm install
```

## Usage

The proxy is invoked with a proto file, the HTTP (REST) port, and the gRPC port:

```sh
node ./grpc-json-proxy.js ./base_node.proto 18144 18142
node ./grpc-json-proxy.js ./wallet.proto 18145 18143
```

By default the HTTP proxy binds to `0.0.0.0` for compatibility with container
port publishing, and connects to gRPC on `127.0.0.1`. Use `--bind 127.0.0.1`
when you only want the JSON-RPC endpoint reachable inside the same host or
container namespace.

```sh
node ./grpc-json-proxy.js ./base_node.proto 18144 18142 \
  --bind 127.0.0.1 \
  --grpc-host 127.0.0.1
```

## Configuration

Behavior is controlled with command-line flags:

| Flag | Description | Default |
| --- | --- | --- |
| `--bind <host>` | REST bind address | `0.0.0.0` |
| `--grpc-host <host>` | gRPC target host | `127.0.0.1` |
| `--grpc-port <port>` | Override positional gRPC port | positional arg |
| `--service <name>` | Expose one service, e.g. `tari.rpc.BaseNode` | all entry-proto services |
| `--status-interval <ms\|s>` | Status line interval | `30s` |
| `--max-body-bytes <bytes>` | Maximum JSON body size | `1048576` |
| `--quiet` | Disable periodic status lines | off |
| `--verbose` | Print full error stacks | off |
| `--timestamps` | Prefix proxy log lines with ISO timestamps | off |
| `--help` | Show help | — |

## API

### JSON-RPC endpoint

Send JSON-RPC 2.0 requests to:

```text
POST /json_rpc
```

Examples:

```sh
curl -sS http://127.0.0.1:18144/json_rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":0,"method":"GetTipInfo"}' | jq
```

```sh
curl -sS http://127.0.0.1:18144/json_rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"blocks-3409","method":"GetBlocks","params":{"heights":["3409"]}}' | jq
```

```sh
curl -sS http://127.0.0.1:18145/json_rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"completed","method":"GetCompletedTransactions"}' | jq
```

Use fully qualified method names if you intentionally expose a proto that has
duplicate bare method names:

```json
{
  "jsonrpc": "2.0",
  "id": "tip",
  "method": "tari.rpc.BaseNode.GetTipInfo",
  "params": {}
}
```

### Behavior notes

- Only unary and server-streaming gRPC methods are supported.
- Server-streaming responses are returned as JSON arrays.
- Client-streaming and bidirectional-streaming methods return a JSON-RPC error.
- `params` must be a JSON object when supplied.
- Request ids such as `0`, `""`, and `null` are accepted as valid JSON-RPC ids.
- The default service set is limited to services declared by the entry proto, so
  imported proto services are not exposed unless you pass `--service`.

### Output

Normal output is intentionally compact:

```text
proxy listening rest=0.0.0.0:18144 grpc=127.0.0.1:18142 proto=base_node.proto services=tari.rpc.BaseNode methods=40
processed rest=0.0.0.0:18144 ok=18 error=0 total=18 active=0 uptime=30s
processed rest=0.0.0.0:18144 ok=22 error=1 total=23 active=0 uptime=60s repeated_errors=3
```

Errors are one-line summaries by default:

```text
error method=GetTipInfo message="No connection established"
```

Repeated errors are deduplicated and counted in the next status line. Use
`--timestamps` if you want ISO timestamps from the proxy itself; otherwise rely
on your process manager or container runtime timestamps. Use `--verbose` while
debugging if you need full stack traces.

## Updating Tari protos

The vendored Tari base node and wallet protos in this repository were refreshed
from:

https://github.com/tari-project/tari/tree/v5.3.0/applications/minotari_app_grpc/proto

The `v5.3.0` proto files matched Tari `mainnet` at the time of this update.
When updating, replace the vendored base node and wallet proto files in this
repository with the matching files from that upstream directory and preserve
their copyright/license headers.

Vendored Tari proto files are copyright The Tari Project and are distributed
under BSD-3-Clause terms in their file headers.

## Testing

The test suite is offline: it starts an in-process mock gRPC server from a small
test proto ([tests/mock.proto](tests/mock.proto)) and does not require a running
Tari daemon.

```sh
npm test            # node --test tests/*.js
npm run check       # syntax check the proxy entry file
npm audit --omit=dev
```

## MoneroOcean ecosystem

| Component | Role |
| --- | --- |
| [nodejs-pool](https://github.com/MoneroOcean/nodejs-pool) | Pool backend — stratum, share storage, payments |
| [mo-pool-ui](https://github.com/MoneroOcean/mo-pool-ui) | Static web frontend for the pool |
| [xmr-node-proxy](https://github.com/MoneroOcean/xmr-node-proxy) | Stratum proxy / share aggregator |
| [mo-miner](https://github.com/MoneroOcean/mo-miner) | MoneroOcean end-user CPU/GPU mining client (multi-algo) |
| [multi-miner](https://github.com/MoneroOcean/multi-miner) | Multi-algo miner manager |
| [node-powhash](https://github.com/MoneroOcean/node-powhash) | Native multi-algo PoW hashing addon |
| [node-randomx](https://github.com/MoneroOcean/node-randomx) | Native RandomX hashing addon |
| [node-blocktemplate](https://github.com/MoneroOcean/node-blocktemplate) | Native block-template & serialization addon |
| [grpc-json-proxy](https://github.com/MoneroOcean/grpc-json-proxy) | gRPC ↔ JSON-RPC proxy (Tari base node) |

## License

BSD-3-Clause. See [LICENSE](LICENSE).
