import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('keyboard rehearsal walks reconstructed controls rather than form collection containers', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function keyboardCoach()');
  const end = source.indexOf('function validationCoach()', start);
  const keyboardCoach = source.slice(start, end);
  assert.match(keyboardCoach, /querySelectorAll\('\[data-control-ref\]'\)/);
  assert.doesNotMatch(keyboardCoach, /elements\.form\.elements/);
});
