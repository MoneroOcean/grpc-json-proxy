# grpc-json-proxy

`grpc-json-proxy` exposes gRPC unary and server-streaming methods as a small
JSON-RPC 2.0 HTTP endpoint. It is intended for Tari base node and wallet gRPC
protos, but it can proxy any compatible proto with unary or server-streaming
methods.

The proxy is quiet by default: it prints one startup line, one periodic status
line, and concise error summaries without stack traces.

## Requirements

- Node.js 20.11 or newer
- A gRPC service matching the proto you expose

Install dependencies:

```sh
npm install
```

## Usage

The original positional form is still supported:

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

Options:

```text
--bind <host>             REST bind address (default: 0.0.0.0)
--grpc-host <host>        gRPC target host (default: 127.0.0.1)
--grpc-port <port>        Override positional gRPC port
--service <name>          Expose one service, for example tari.rpc.BaseNode
--status-interval <ms|s>  Status line interval (default: 30s)
--max-body-bytes <bytes>  Maximum JSON body size (default: 1048576)
--quiet                   Disable periodic status lines
--verbose                 Print full error stacks
--timestamps              Prefix proxy log lines with ISO timestamps
--help                    Show help
```

## JSON-RPC Endpoint

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

## Output

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

## Behavior Notes

- Only unary and server-streaming gRPC methods are supported.
- Server-streaming responses are returned as JSON arrays.
- Client-streaming and bidirectional-streaming methods return a JSON-RPC error.
- `params` must be a JSON object when supplied.
- Request ids such as `0`, `""`, and `null` are accepted as valid JSON-RPC ids.
- The default service set is limited to services declared by the entry proto, so
  imported proto services are not exposed unless you pass `--service`.

## Tests

The test suite is offline. It starts an in-process mock gRPC server from a small
test proto and does not require a Tari daemon.

```sh
npm test
npm run check
npm audit --omit=dev
```

## Updating Tari Protos

The vendored Tari base node and wallet protos in this repository were refreshed
from:

https://github.com/tari-project/tari/tree/v5.3.0/applications/minotari_app_grpc/proto

The `v5.3.0` proto files matched Tari `mainnet` at the time of this update.
When updating, replace the vendored base node and wallet proto files in this
repository with the matching files from that upstream directory and preserve
their copyright/license headers.

Vendored Tari proto files are copyright The Tari Project and are distributed
under BSD-3-Clause terms in their file headers.
