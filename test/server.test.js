import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));

async function startServer(directory) {
  const child = spawn(process.execPath, [join(directory, 'server.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      const match = /:(\d+)/u.exec(String(chunk));
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', (code) => reject(new Error(`Server exited early with code ${code}: ${errors}`)));
  });
  return { child, port, errors: () => errors };
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', reject);
  });
}

test('serves only allowlisted files with security headers', async (t) => {
  const server = await startServer(repository);
  t.after(() => server.child.kill());
  for (const path of ['/', '/index.html', '/src/app.js', '/src/core.js', '/src/styles.css']) {
    const response = await request(server.port, path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers['content-security-policy'], /connect-src 'none'/u);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal((await request(server.port, '/package.json')).status, 404);
  assert.equal((await request(server.port, '/src/../package.json')).status, 404);
  assert.equal((await request(server.port, '/%E0%A4%A')).status, 400);
});

test('a missing allowlisted file returns 404 and the server keeps running', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'formlift-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(join(repository, 'server.mjs'), join(directory, 'server.mjs'));
  await copyFile(join(repository, 'index.html'), join(directory, 'index.html'));
  const server = await startServer(directory);
  t.after(() => server.child.kill());
  const missing = await request(server.port, '/src/styles.css');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request(server.port, '/')).status, 200);
  assert.equal(server.child.exitCode, null);
  assert.equal(server.errors(), '');
});
