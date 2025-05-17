# grpc-json-proxy

To run (update .proto files from https://github.com/tari-project/tari/tree/mainnet/applications/minotari_app_grpc/proto if needed)

```
node ./grpc-json-proxy.js ./base_node.proto 18144 18142 # for base node
node ./grpc-json-proxy.js ./wallet.proto 18145 18143 # for wallet
```

Usage examples:

```
curl -X POST http://localhost:18144/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"GetTipInfo"}' -H 'Content-Type: application/json'
curl -X POST http://localhost:18144/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"GetBlocks","params":{"heights":[3409]}}' -H 'Content-Type: application/json'
curl -X POST http://localhost:18144/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"GetHeaderByHash","params":{"hash":[171, 103, 157, 103, 80, 134, 176, 172, 157, 252, 4, 33, 194, 1, 144, 248, 81, 8, 82, 152, 211, 59, 49, 73, 254, 169, 235, 77, 248, 183, 240, 99]}}' -H 'Content-Type: application/json'
curl -X POST http://localhost:18145/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"GetCompletedTransactions"}' -H 'Content-Type: application/json' | jq
```
