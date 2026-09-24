import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Playwright is optional so the app itself stays dependency-free. Without it these tests are skipped.
const require = createRequire(import.meta.url);
let playwright = null;
try {
  playwright = require('playwright');
} catch {
  playwright = null;
}
const skip = playwright ? false : 'Playwright is not installed, so browser tests are skipped (see README).';
const server = fileURLToPath(new URL('../server.mjs', import.meta.url));

let child;
let browser;
let origin;

async function openApp() {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.goto(origin);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return { page, problems };
}

async function waitForStatus(page, pattern) {
  await page.waitForFunction((source) => new RegExp(source, 'u').test(document.querySelector('#job-status').textContent), pattern.source);
  return page.textContent('#job-status');
}

async function scan(page, html) {
  await page.fill('#html-source', html);
  await page.click('#scan-button');
  await waitForStatus(page, /Inventory complete|failed/u);
  return page.evaluate(() => ({
    status: document.querySelector('#job-status').textContent,
    summary: document.querySelector('#inventory-summary').textContent,
    findings: [...document.querySelectorAll('#findings article h3')].map((heading) => heading.textContent),
    fields: [...document.querySelectorAll('#rehearsal-form [data-control-ref]')].map((field) => ({
      ref: field.dataset.controlRef,
      tag: field.tagName.toLowerCase(),
      type: field.type,
      label: field.labels?.[0]?.textContent ?? field.textContent
    }))
  }));
}

async function prepare(page, scenario) {
  await page.selectOption('#scenario-select', scenario);
  await page.click('#start-scenario');
  await waitForStatus(page, /rehearsal complete|rehearsal stopped|rehearsal failed/u);
}

function timeline(page) {
  return page.$$eval('#timeline li', (items) => items.map((item) => item.textContent));
}

describe('browser app', { skip }, () => {
  before(async () => {
    child = spawn(process.execPath, [server, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        const match = /:(\d+)/u.exec(String(chunk));
        if (match) resolve(Number(match[1]));
      });
      child.once('exit', (code) => reject(new Error(`Server exited with code ${code}.`)));
    });
    origin = `http://127.0.0.1:${port}/`;
    browser = await playwright.chromium.launch();
  });

  after(async () => {
    await browser?.close();
    child?.kill();
  });

  test('the defect fixture produces the documented inventory and findings', async () => {
    const { page, problems } = await openApp();
    await page.click('#fixture-button');
    await page.click('#scan-button');
    await waitForStatus(page, /Inventory complete/u);
    const summary = await page.textContent('#inventory-summary');
    const findings = await page.$$eval('#findings article h3', (headings) => headings.map((heading) => heading.textContent));
    assert.match(summary, /^6 controls · 8 focused automated findings/u);
    assert.deepEqual(findings, [
      'error-association at #display-name',
      'autocomplete at #display-name',
      'accessible-name at #email',
      'error-announcement at #email',
      'error-association at #password',
      'radio-group at #contact-email',
      'radio-group at #contact-phone',
      'submit-progress at button:nth-control(6)'
    ]);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('supplied scripts, handlers and default values never reach the live page', async () => {
    const { page, problems } = await openApp();
    const result = await scan(page, `<form id="f"><script>window.ran = 'script'</script>
      <img src="x" onerror="window.ran = 'handler'">
      <label for="name">Name</label><input id="name" autocomplete="name" value="secret-default-value">
      <label for="notes">Notes</label><textarea id="notes">secret-textarea-value</textarea>
      <button type="submit" formaction="https://example.invalid/">Send</button></form>`);
    assert.match(result.status, /Inventory complete: 3 supported controls/u);
    assert.equal(await page.evaluate(() => window.ran ?? null), null);
    const values = await page.$$eval('#rehearsal-form input, #rehearsal-form textarea', (fields) => fields.map((field) => field.value));
    assert.deepEqual(values, ['', '']);
    await page.click('#report-button');
    await page.waitForSelector('#report-dialog[open]');
    assert.doesNotMatch(await page.textContent('.report-preview'), /secret-/u);
    assert.doesNotMatch(await page.innerHTML('#project'), /secret-|example\.invalid/u);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('keyboard rehearsal records a focus stop for each reconstructed control', async () => {
    const { page } = await openApp();
    await scan(page, '<form><label for="a">A</label><input id="a" autocomplete="off"><label for="b">B</label><input id="b" autocomplete="off"><button type="submit">Go</button></form>');
    await prepare(page, 'keyboard');
    while (await page.isVisible('#scenario-coach')) await page.click('#scenario-coach button');
    const entries = await timeline(page);
    assert.deepEqual(entries.slice(0, 2), [
      'instrumented observation: #a — Focus moved to position 1 of 3.',
      'instrumented observation: #b — Focus moved to position 2 of 3.'
    ]);
    assert.match(await page.textContent('#job-status'), /Keyboard-path rehearsal complete/u);
    await page.close();
  });

  test('validation rehearsal records invalid required controls and focuses the first', async () => {
    const { page } = await openApp();
    await scan(page, '<form><label for="a">A</label><input id="a" required autocomplete="off"><label for="b">B</label><input id="b" required autocomplete="off"></form>');
    await prepare(page, 'validation');
    await page.click('text=Trigger local validation');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.controlRef), '#a');
    await page.fill('[data-control-ref="#a"]', 'Synthetic');
    await page.fill('[data-control-ref="#b"]', 'Synthetic');
    await page.click('text=Record retry and finish');
    const entries = await timeline(page);
    assert.ok(entries.includes('instrumented observation: #a — Local constraint validation identified this control as invalid. Entry present: no.'));
    assert.equal(entries.at(-1), 'instrumented observation: form — A local retry passed constraint validation.');
    assert.equal(await page.inputValue('[data-control-ref="#a"]'), '');
    await page.close();
  });

  test('slow-submit rehearsal records retention after the delay', async () => {
    const { page } = await openApp();
    await scan(page, '<form><label for="a">A</label><input id="a" autocomplete="off"><button type="submit">Go</button><p role="status"></p></form>');
    await prepare(page, 'slow-submit');
    await page.fill('[data-control-ref="#a"]', 'Synthetic');
    await page.click('text=Begin disclosed three-second delay');
    await waitForStatus(page, /Slow-submit rehearsal complete/u);
    assert.ok((await timeline(page)).includes('instrumented observation: #a — Rehearsal entry remained after the delay. Entry present: yes. Retained: yes.'));
    await page.close();
  });

  test('reports download as Markdown and JSON', async () => {
    const { page } = await openApp();
    await page.click('#fixture-button');
    await page.click('#scan-button');
    await waitForStatus(page, /Inventory complete/u);
    await page.click('#report-button');
    await page.waitForSelector('#report-dialog[open]');
    const [markdown] = await Promise.all([page.waitForEvent('download'), page.click('text=Download Markdown')]);
    assert.equal(markdown.suggestedFilename(), 'formlift-report.md');
    assert.match(await readFile(await markdown.path(), 'utf8'), /## Automated findings/u);
    const [json] = await Promise.all([page.waitForEvent('download'), page.click('text=Download JSON')]);
    const report = JSON.parse(await readFile(await json.path(), 'utf8'));
    assert.equal(report.inventory.controlCount, 6);
    assert.equal(report.findings.length, 8);
    await page.close();
  });
});
