import { readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(argumentsList) {
  const result = spawnSync(process.execPath, argumentsList, { cwd: repository, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
async function modules(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await modules(path));
    if (entry.isFile() && ['.js', '.mjs'].includes(extname(entry.name))) found.push(path);
  }
  return found;
}
run(['--test']);
for (const path of await modules(repository)) run(['--check', path]);
console.log('Tests and JavaScript syntax checks passed.');
