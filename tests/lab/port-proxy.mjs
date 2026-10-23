// Test lab: a tiny local-only forward proxy so the lab can run the normal e2e suite (whose pages and
// checks expect http://127.0.0.1:4318) WITHOUT taking port 4318, which other agents use for their runs.
// Chrome is started with --proxy-server=http://127.0.0.1:<LAB_PROXY_PORT> --proxy-bypass-list=<-loopback>,
// so every request (also to 127.0.0.1) comes here; requests to port 4318 go to the lab's own preview
// server (LAB_PORT), everything else on 127.0.0.1 passes straight through. Any other host is refused.
import http from 'node:http';
import net from 'node:net';

const LISTEN = Number(process.env.LAB_PROXY_PORT || 4328);
const TARGET = Number(process.env.LAB_PORT || 4327);
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);
const mapPort = (p) => (Number(p) === 4318 ? TARGET : Number(p));

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url);
  } catch {
    res.writeHead(400).end('bad proxy request');
    return;
  }
  if (!LOCAL.has(u.hostname)) {
    res.writeHead(403).end('lab proxy: only 127.0.0.1');
    return;
  }
  const up = http.request({ host: '127.0.0.1', port: mapPort(u.port || 80), path: u.pathname + u.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${u.port}` } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on('error', () => up.destroy());
  res.on('error', () => up.destroy());
  req.pipe(up);
});

// WebSockets (ws://127.0.0.1:<relay>) come as CONNECT tunnels.
server.on('connect', (req, sock, head) => {
  const [host, port] = req.url.split(/:(?=\d+$)/);
  if (!LOCAL.has(host)) {
    sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const up = net.connect(mapPort(port), '127.0.0.1', () => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});

// A browser that closes a socket mid-request must never take the proxy down.
server.on('clientError', (_e, sock) => sock.destroy());
process.on('uncaughtException', (e) => console.error('lab port-proxy (kept running):', e.message));

server.listen(LISTEN, '127.0.0.1', () => console.log(`lab port-proxy on ${LISTEN}: 4318 -> ${TARGET}`));
