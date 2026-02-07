#!/usr/bin/env node
/**
 * Minimal HTTP CONNECT proxy for testing the proxy feature.
 *
 * Usage:
 *   1. node scripts/test-proxy.mjs          (starts on port 9999)
 *   2. In CodePilot Settings, set proxy to http://127.0.0.1:9999, enable it
 *   3. Send a message in chat
 *   4. Watch this terminal — you should see CONNECT requests to api.anthropic.com
 *
 * Press Ctrl+C to stop.
 */

import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

const PORT = parseInt(process.argv[2] || '9999', 10);
let requestCount = 0;

const server = http.createServer((req, res) => {
  // Handle normal HTTP proxy requests (non-CONNECT)
  requestCount++;
  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`[${timestamp}] #${requestCount} HTTP ${req.method} ${req.url}`);

  try {
    const target = new URL(req.url);
    const proxyReq = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', (err) => {
      console.log(`  -> ERROR: ${err.message}`);
      res.writeHead(502);
      res.end('Bad Gateway');
    });
    req.pipe(proxyReq);
  } catch (err) {
    res.writeHead(400);
    res.end('Bad Request');
  }
});

// Handle HTTPS CONNECT tunneling
server.on('connect', (req, clientSocket, head) => {
  requestCount++;
  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`[${timestamp}] #${requestCount} CONNECT ${req.url}`);

  const [hostname, port] = req.url.split(':');
  const serverSocket = net.connect(parseInt(port) || 443, hostname, () => {
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      'Proxy-agent: codepilot-test-proxy\r\n' +
      '\r\n'
    );
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', (err) => {
    console.log(`  -> CONNECT ERROR to ${req.url}: ${err.message}`);
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });

  clientSocket.on('error', () => serverSocket.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('  CodePilot Test Proxy');
  console.log('='.repeat(60));
  console.log(`  Listening on: http://127.0.0.1:${PORT}`);
  console.log('');
  console.log('  Steps:');
  console.log(`  1. Open CodePilot Settings`);
  console.log(`  2. Enable proxy, set URL to http://127.0.0.1:${PORT}`);
  console.log(`  3. Save, then send a chat message`);
  console.log(`  4. Watch this terminal for CONNECT/HTTP requests`);
  console.log('');
  console.log('  Expected output:');
  console.log('    CONNECT api.anthropic.com:443');
  console.log('');
  console.log('  Press Ctrl+C to stop');
  console.log('='.repeat(60));
  console.log('');
});
