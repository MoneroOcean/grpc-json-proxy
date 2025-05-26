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
  packageDefinition = protoLoader.loadSync(protoFilePath, { keepCase: true });
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

// in all subobjects covert buffers like
// {"type":"Buffer","data":[94,59,76,39,128,46,71,2,177,74,200,165,51,16,252,136,178,140,60,210,117,43,142,107,70,190,190,37,59,22,18,52]}to hex strings
function convertBuffersToHex(obj) {
  if (Array.isArray(obj)) {
    return obj.map(convertBuffersToHex);
  }

  if (obj && typeof obj === 'object') {
    // Check for Buffer-like structure
    if (
      obj.type === 'Buffer' &&
      Array.isArray(obj.data) &&
      obj.data.every(n => typeof n === 'number')
    ) {
      return Buffer.from(obj.data).toString('hex');
    }

    // Convert protobuf Long-like object to number
    if (
      typeof obj.low === 'number' &&
      typeof obj.high === 'number' &&
      typeof obj.unsigned === 'boolean'
    ) {
      // Use BigInt to safely handle 64-bit ints
      const low = BigInt(obj.low >>> 0);  // >>> 0 ensures unsigned interpretation
      const high = BigInt(obj.high >>> 0);
      const result = (high << 32n) | low;
      return obj.unsigned ? Number(result) : Number(result << 0n); // convert to signed if needed
    }

    // Recurse into nested objects
    const result = {};
    for (const key in obj) {
      result[key] = convertBuffersToHex(obj[key]);
    }
    return result;
  }

  // Return non-object values unchanged
  return obj;
}

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
            result: convertBuffersToHex(JSON.parse(JSON.stringify(response))),
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
           result: convertBuffersToHex(JSON.parse(JSON.stringify(stream_data))),
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
server.listen(portREST, () => {
  console.log(`JSON-RPC proxy listening on http://localhost:${portREST}`);
});

