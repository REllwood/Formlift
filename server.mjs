import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const portIndex = process.argv.indexOf('--port');
const requested = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : Number(process.env.PORT ?? 4177);
const port = Number.isInteger(requested) && requested >= 0 && requested <= 65535 ? requested : 4177;
const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8']
]);
const publicFiles = new Map([
  ['/', resolve(root, 'index.html')],
  ['/index.html', resolve(root, 'index.html')],
  ['/src/app.js', resolve(root, 'src/app.js')],
  ['/src/core.js', resolve(root, 'src/core.js')],
  ['/src/styles.css', resolve(root, 'src/styles.css')]
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${host}`).pathname);
    const target = publicFiles.get(pathname);
    if (!target) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': types.get(extname(target)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    response.end(await readFile(target));
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    response.writeHead(missing ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(missing ? 'Not found' : 'Invalid request');
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const activePort = address && typeof address === 'object' ? address.port : port;
  console.log(`Formlift is available at http://${host}:${activePort}`);
});
const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
