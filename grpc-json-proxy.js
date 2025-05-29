// npm install @grpc/grpc-js @grpc/proto-loader

const http = require('http');
const url = require('url');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

function help() {
  console.log("node grpc-json-proxy.js <.proto file> <JSON REST port> <gRPC port>");
  process.exit(1);
}

// Command-line argument: path to .proto file
const protoFilePath = process.argv[2]; // path to .proto file
if (!protoFilePath) {
  console.error("Error: You must provide the path to a .proto file.");
  return help();
}

const portREST = process.argv[3]; // JSON REST server port name
if (!portREST) {
  console.error("Error: You must provide JSON RESET port number");
  return help();
}

const portGRPC = process.argv[4]; // GRPC server port name
if (!portGRPC) {
  console.error("Error: You must provide GRPC port number");
  return help();
}

// Load and parse the .proto file
let packageDefinition;
try {
  packageDefinition = protoLoader.loadSync(protoFilePath, { keepCase: true, bytes: Array, longs: String });
} catch (e) {
  console.error("Error loading .proto file:", e);
  return help();
}

// Create gRPC methods with clients
const clients = {};
const methods = {};

function map_functions(service, path) {
  Object.keys(service).forEach(function(name) {
    const path2 = `${path}.${name}`;
    if (typeof service[name] === 'function' && 'service' in service[name]) {
      clients[path2] = new service[name](`localhost:${portGRPC}`, grpc.credentials.createInsecure());
      Object.keys(service[name].service).forEach(function(funcname) {
        console.log(`Adding ${funcname} method`);
        methods[funcname] = path2;
      });
    } else if (!('type' in service[name])) return map_functions(service[name], path ? path2 : name);
  });
}

const proto = grpc.loadPackageDefinition(packageDefinition);
map_functions(proto);

// Create an HTTP server to act as the proxy
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const method = req.method;

  // Only handle POST requests to /json_rpc
  if (req.url !== '/json_rpc' || method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      json_rpc: "2.0",
      error: { code: 100, message: "Endpoint not found" },
      id: null
    }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', () => {
    try {
      // Parse the JSON-RPC request body
      const request = JSON.parse(body);

      // Validate the JSON-RPC structure
      if (request.jsonrpc !== "2.0" || !request.method || !request.id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          json_rpc: "2.0",
          error: { code: 101, message: "Invalid Request" },
          id: request.id || null
        }));
        return;
      }

      const { method, params, id } = request;

      // Check if the method exists in any gRPC service
      if (!methods[method]) {
        console.error(`Method ${method} not found in gRPC services.`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          json_rpc: "2.0",
          error: { code: 102, message: "Method not found" },
          id: id
        }));
        return;
      }

      // Call the gRPC method with the parameters
      let stream_data = [];
      let is_err = false;
      clients[methods[method]][method](params || {}, (err, response) => {
        if (err) {
          console.error("gRPC call error:", err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            json_rpc: "2.0",
            error: { code: 103, message: "Internal error", data: err.message },
            id: id
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            json_rpc: "2.0",
            result: response,
            id: id
          }));
        }
      }).on('data', (data) => {
         stream_data.push(data);
      }).on('end', () => {
         if (is_err) return;
         res.writeHead(200, { 'Content-Type': 'application/json' });
         res.end(JSON.stringify({
           json_rpc: "2.0",
           result: stream_data,
           id: id
         }));
      }).on('error', (e) => {
        is_err = true;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          json_rpc: "2.0",
          error: { code: 104, message: "Internal error exception", data: e.message },
          id: id
        }));
      });

    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        json_rpc: "2.0",
        error: { code: 105, message: "Parse error" },
        id: null
      }));
    }
  });
});

// Start the server
server.listen(portREST, "127.0.0.1", () => {
  console.log(`JSON-RPC proxy listening on http://localhost:${portREST}`);
});

