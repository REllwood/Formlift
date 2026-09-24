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
      label: field.labels?.[0]?.textContent ?? field.textContent,
      note: field.closest('.rehearsal-field')?.querySelector('.source-ref')?.textContent ?? ''
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

  test('validation evidence reads checkbox and radio state, not their "on" value', async () => {
    const { page } = await openApp();
    await scan(page, `<form><input id="terms" type="checkbox" required><label for="terms">I agree</label>
      <fieldset><legend>Contact</legend><input id="email" type="radio" name="contact" required><label for="email">Email</label>
      <input id="phone" type="radio" name="contact" required><label for="phone">Phone</label></fieldset></form>`);
    await prepare(page, 'validation');
    await page.click('text=Trigger local validation');
    const entries = await timeline(page);
    for (const ref of ['#terms', '#email', '#phone']) {
      assert.ok(entries.includes(`instrumented observation: ${ref} — Local constraint validation identified this control as invalid. Entry present: no.`), ref);
    }
    await page.check('[data-control-ref="#terms"]');
    await page.check('[data-control-ref="#phone"]');
    await page.click('text=Record retry and finish');
    assert.equal((await timeline(page)).at(-1), 'instrumented observation: form — A local retry passed constraint validation.');
    await page.close();
  });

  test('slow-submit retention reflects checked state after a simulated failure', async () => {
    const { page } = await openApp();
    await scan(page, `<form><fieldset><legend>Contact</legend><input id="email" type="radio" name="contact"><label for="email">Email</label>
      <input id="phone" type="radio" name="contact"><label for="phone">Phone</label></fieldset>
      <input id="news" type="checkbox"><label for="news">News</label>
      <label for="name">Name</label><input id="name" autocomplete="name"><button type="submit">Go</button><p role="status"></p></form>`);
    await prepare(page, 'slow-submit');
    await page.check('[data-control-ref="#phone"]');
    await page.fill('[data-control-ref="#name"]', 'Synthetic');
    await page.check('#scenario-coach input[type="checkbox"]');
    await page.click('text=Begin disclosed three-second delay');
    await waitForStatus(page, /Slow-submit rehearsal complete/u);
    const retention = (await timeline(page)).filter((entry) => entry.includes('Retained'));
    assert.deepEqual(retention, [
      'instrumented observation: #phone — Test-only failed response cleared this rehearsal entry. Entry present: yes. Retained: no.',
      'instrumented observation: #name — Test-only failed response cleared this rehearsal entry. Entry present: yes. Retained: no.'
    ]);
    await page.close();
  });

  describe('actions taken during the slow-submit delay', () => {
    const form = '<form><label for="a">A</label><input id="a" autocomplete="off"><button type="submit">Go</button></form>';

    async function startDelay() {
      const opened = await openApp();
      await scan(opened.page, form);
      await prepare(opened.page, 'slow-submit');
      await opened.page.fill('[data-control-ref="#a"]', 'Synthetic');
      await opened.page.click('text=Begin disclosed three-second delay');
      await opened.page.waitForTimeout(300);
      return opened;
    }

    test('preparing another rehearsal succeeds', async () => {
      const { page, problems } = await startDelay();
      await prepare(page, 'keyboard');
      await page.waitForTimeout(3200);
      assert.equal(await page.textContent('#scenario-coach h3'), 'Keyboard path');
      assert.equal(await page.isVisible('#stop-scenario'), true);
      assert.equal(await page.textContent('#job-status'), 'preparing Keyboard path rehearsal complete.');
      assert.equal((await timeline(page)).some((entry) => entry.includes('Injected delay ended')), false);
      assert.deepEqual(problems, []);
      await page.close();
    });

    test('rescanning succeeds', async () => {
      const { page } = await startDelay();
      const result = await scan(page, '<form><label for="z">Z</label><input id="z" autocomplete="off"><label for="y">Y</label><input id="y" autocomplete="off"></form>');
      assert.match(result.summary, /^2 controls/u);
      assert.match(result.status, /^Inventory complete: 2 supported controls/u);
      await page.close();
    });

    test('opening the report succeeds and shows the stopped rehearsal', async () => {
      const { page } = await startDelay();
      await page.click('#report-button');
      await page.waitForSelector('#report-dialog[open]');
      assert.match(await page.textContent('.report-preview'), /Status: stopped with incomplete evidence/u);
      await page.close();
    });

    test('Stop current work ends the rehearsal and clears entries', async () => {
      const { page } = await startDelay();
      await page.click('#cancel-job');
      await page.waitForSelector('#scenario-coach', { state: 'hidden' });
      assert.equal(await page.textContent('#job-status'), 'simulating slow submit on the local reconstruction stopped. Rehearsal entries were cleared.');
      assert.equal(await page.inputValue('[data-control-ref="#a"]'), '');
      await page.close();
    });

    test('Stop and clear keeps its own status message', async () => {
      const { page } = await startDelay();
      await page.click('#stop-scenario');
      await page.waitForTimeout(100);
      assert.match(await page.textContent('#job-status'), /^Rehearsal stopped\. Timers and instrumentation were removed/u);
      await page.close();
    });
  });

  test('accessible names follow the browser naming order', async () => {
    const { page, problems } = await openApp();
    const result = await scan(page, `<label for="outside">Outside label</label>
      <form>
        <input id="outside" autocomplete="off">
        <span id="heading">Referenced name</span>
        <input id="both" aria-label="Ignored label" aria-labelledby="heading" autocomplete="off">
        <label for="starred">Email <span aria-hidden="true">*</span></label><input id="starred" type="email" autocomplete="email">
        <label>Wrapped <input id="wrapped" autocomplete="off"></label>
        <input id="send" type="submit" value="Send">
        <input id="default-submit" type="submit">
        <input id="reset" type="reset">
        <input id="map" type="image" alt="Search map" src="map.png">
        <input id="bare-image" type="image" src="map.png">
        <button id="icon" type="button"><img src="close.png" alt="Close"></button>
        <input id="placeholder-only" placeholder="Postcode" autocomplete="postal-code">
        <select id="title-only" title="Country"><option>Australia</option></select>
      </form>`);
    const names = Object.fromEntries(result.fields.filter(({ ref }) => ref !== '#bare-image').map(({ ref, label }) => [ref, label]));
    assert.deepEqual(names, {
      '#outside': 'Outside label',
      '#both': 'Referenced name',
      '#starred': 'Email',
      '#wrapped': 'Wrapped',
      '#send': 'Send',
      '#default-submit': 'Submit',
      '#reset': 'Reset',
      '#map': 'Search map',
      '#icon': 'Close',
      '#placeholder-only': 'Postcode',
      '#title-only': 'Country'
    });
    const sources = Object.fromEntries(result.fields.map(({ ref, note }) => [ref, /name from ([^;]+)/u.exec(note)?.[1] ?? '']));
    assert.equal(sources['#outside'], 'label[for]');
    assert.equal(sources['#both'], 'aria-labelledby');
    assert.equal(sources['#wrapped'], 'wrapping label');
    assert.equal(sources['#send'], 'value');
    assert.equal(sources['#default-submit'], 'default button text');
    assert.equal(sources['#map'], 'alt');
    assert.equal(sources['#placeholder-only'], 'placeholder');
    assert.deepEqual(result.findings.filter((heading) => /^(accessible-name|visible-label) /u.test(heading)), [
      'accessible-name at #bare-image',
      'visible-label at #placeholder-only',
      'visible-label at #title-only'
    ]);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('every standard input type is kept and rebuilt with its own type', async () => {
    const { page, problems } = await openApp();
    const result = await scan(page, `<form>
      <label for="volume">Volume</label><input id="volume" type="range">
      <label for="colour">Colour</label><input id="colour" type="color">
      <label for="time">Time</label><input id="time" type="time">
      <label for="when">When</label><input id="when" type="datetime-local">
      <label for="month">Month</label><input id="month" type="month">
      <label for="week">Week</label><input id="week" type="week">
      <label for="find">Find</label><input id="find" type="search">
      <label for="typo">Typo</label><input id="typo" type="emial">
      <input id="go" type="image" alt="Go" src="go.png">
    </form>`);
    assert.deepEqual(result.fields.map(({ ref, tag, type }) => `${ref} ${tag} ${type}`), [
      '#volume input range', '#colour input color', '#time input time', '#when input datetime-local', '#month input month',
      '#week input week', '#find input search', '#typo input text', '#go button submit'
    ]);
    assert.deepEqual(result.findings, ['autocomplete at #typo', 'submit-progress at #go']);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('controls associated with the form attribute are included and others excluded', async () => {
    const { page } = await openApp();
    const result = await scan(page, `<form id="main"><label for="inside">Inside</label><input id="inside" autocomplete="off">
      <label for="foreign">Foreign</label><input id="foreign" form="other" autocomplete="off"></form>
      <label for="outside">Outside</label><input id="outside" form="main" autocomplete="off"><form id="other"></form>`);
    assert.deepEqual(result.fields.map(({ ref }) => ref), ['#inside', '#outside']);
    await page.close();
  });

  test('an untouched range is not reported as an entry', async () => {
    const { page } = await openApp();
    await scan(page, `<form><label for="volume">Volume</label><input id="volume" type="range">
      <label for="level">Level</label><input id="level" type="range"><button type="submit">Go</button><p role="status"></p></form>`);
    await prepare(page, 'slow-submit');
    await page.$eval('[data-control-ref="#level"]', (field) => { field.value = '80'; });
    await page.click('text=Begin disclosed three-second delay');
    await waitForStatus(page, /Slow-submit rehearsal complete/u);
    const retention = (await timeline(page)).filter((entry) => entry.includes('Retained'));
    assert.deepEqual(retention, ['instrumented observation: #level — Rehearsal entry remained after the delay. Entry present: yes. Retained: yes.']);
    await page.close();
  });

  describe('human observations', () => {
    const formA = '<form id="form-a" aria-label="Form A"><label for="a">A</label><input id="a" autocomplete="off"></form>';
    const formB = '<form id="form-b" aria-label="Form B"><label for="b">B</label><input id="b" autocomplete="off"></form>';
    const notesOf = (page) => page.$$eval('#note-list li span', (items) => items.map((item) => item.textContent));

    async function addNote(page, text) {
      await page.fill('#note-input', text);
      await page.click('#note-form button[type="submit"]');
    }

    test('belong to the form they were written for and survive a reload', async () => {
      const { page } = await openApp();
      await scan(page, formA);
      await addNote(page, 'Observation about form A');
      await page.reload();
      await scan(page, formB);
      assert.deepEqual(await notesOf(page), []);
      await page.click('#report-button');
      await page.waitForSelector('#report-dialog[open]');
      assert.match(await page.textContent('.report-preview'), /No human observations recorded/u);
      await page.click('.dialog-close');
      await scan(page, formA);
      assert.deepEqual(await notesOf(page), ['Observation about form A']);
      await page.close();
    });

    test('can be deleted one at a time or cleared after confirmation', async () => {
      const { page } = await openApp();
      await scan(page, formA);
      for (const text of ['First', 'Second', 'Third']) await addNote(page, text);
      await page.click('button[aria-label="Delete observation 2"]');
      assert.deepEqual(await notesOf(page), ['First', 'Third']);
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Delete observation 2');
      await page.reload();
      await scan(page, formA);
      assert.deepEqual(await notesOf(page), ['First', 'Third']);
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.click('#clear-notes');
      assert.deepEqual(await notesOf(page), ['First', 'Third']);
      page.once('dialog', (dialog) => dialog.accept());
      await page.click('#clear-notes');
      assert.deepEqual(await notesOf(page), []);
      assert.equal(await page.isVisible('#clear-notes'), false);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).length), 0);
      await page.close();
    });

    test('notes from version 0.1 move to the first form scanned', async () => {
      const { page } = await openApp();
      await page.evaluate(() => localStorage.setItem('formlift:notes:v0.1', JSON.stringify(['Older shared note'])));
      await page.reload();
      await scan(page, formA);
      assert.deepEqual(await notesOf(page), ['Older shared note']);
      assert.equal(await page.evaluate(() => localStorage.getItem('formlift:notes:v0.1')), null);
      await scan(page, formB);
      assert.deepEqual(await notesOf(page), []);
      await page.close();
    });
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
