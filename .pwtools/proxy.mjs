import http from 'node:http';
import net from 'node:net';

const TARGET = { host: '127.0.0.1', port: 3000 };

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { ...TARGET, path: req.url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream dev server unavailable');
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET, () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (const [key, value] of Object.entries(req.headers)) {
      upstream.write(`${key}: ${value}\r\n`);
    }
    upstream.write('\r\n');
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(3001, '0.0.0.0', () => {
  console.log('preview proxy: 0.0.0.0:3001 -> 127.0.0.1:3000');
});
