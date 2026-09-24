import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  checkInventory,
  createSession,
  finishSession,
  recordEvidence,
  validateInventory
} from '../src/core.js';

const inventory = {
  formReference: '#synthetic-account',
  title: 'Synthetic account form',
  hasLiveRegion: false,
  hasProgressText: false,
  controls: [
    { sourceRef: '#name', element: 'input', type: 'text', accessibleName: 'Display name', nameSource: 'label[for]', required: true, autocomplete: '', describedBy: [] },
    { sourceRef: '#email', element: 'input', type: 'email', accessibleName: '', required: true, autocomplete: 'email', describedBy: ['email-error'], errorTextPresent: true, errorAnnounced: false },
    { sourceRef: '#contact-email', element: 'input', type: 'radio', accessibleName: 'Email', groupName: 'contact', groupLabel: '' },
    { sourceRef: '#submit', element: 'button', type: 'submit', accessibleName: 'Create account', nameSource: 'button text' }
  ]
};

test('inventory validation bounds controls and keeps structural metadata only', () => {
  const result = validateInventory(inventory);
  assert.equal(result.controls.length, 4);
  assert.equal(Object.hasOwn(result.controls[0], 'value'), false);
  assert.equal(result.controls[0].defaultEntryPresent, false);
  assert.throws(() => validateInventory({ controls: [] }), /no supported controls/i);
});

test('standard input types are kept and unknown ones become text', () => {
  const types = ['range', 'color', 'time', 'datetime-local', 'month', 'week', 'image', 'search', 'made-up'];
  const result = validateInventory({ controls: types.map((type, index) => ({ sourceRef: `#c${index}`, type })) });
  assert.deepEqual(result.controls.map(({ type }) => type), [...types.slice(0, -1), 'text']);
});

test('an image input counts as the submit control for submit-progress', () => {
  const findings = checkInventory({ controls: [{ sourceRef: '#go', element: 'input', type: 'image', accessibleName: 'Go' }] });
  assert.deepEqual(findings.map(({ ruleId, sourceRef }) => `${ruleId} ${sourceRef}`), ['submit-progress #go']);
});

test('select labels are retained without option values or selected state', () => {
  const supplied = structuredClone(inventory);
  supplied.controls.push({ sourceRef: '#country', element: 'select', type: 'select', accessibleName: 'Country', options: ['Australia', 'New Zealand'], value: 'private-value', selectedIndex: 1 });
  const result = validateInventory(supplied).controls.at(-1);
  assert.deepEqual(result.options, ['Australia', 'New Zealand']);
  assert.equal(Object.hasOwn(result, 'value'), false);
  assert.equal(Object.hasOwn(result, 'selectedIndex'), false);
});

test('focused checks produce evidence-backed accessible-name, error and progress findings', () => {
  const findings = checkInventory(inventory);
  assert.ok(findings.some(({ ruleId, sourceRef }) => ruleId === 'accessible-name' && sourceRef === '#email'));
  assert.ok(findings.some(({ ruleId }) => ruleId === 'error-announcement'));
  assert.ok(findings.some(({ ruleId }) => ruleId === 'radio-group'));
  assert.ok(findings.some(({ ruleId }) => ruleId === 'submit-progress'));
  assert.equal(findings.every(({ origin, consequence, evidence }) => origin === 'automated' && Boolean(consequence) && Boolean(evidence)), true);
});

test('controls named only by a placeholder or title get a visible-label finding instead of accessible-name', () => {
  const findings = checkInventory({
    controls: [
      { sourceRef: '#postcode', type: 'text', accessibleName: 'Postcode', nameSource: 'placeholder', autocomplete: 'postal-code' },
      { sourceRef: '#country', type: 'select', accessibleName: 'Country', nameSource: 'title' },
      { sourceRef: '#suburb', type: 'text', accessibleName: 'Suburb', nameSource: 'label[for]', autocomplete: 'address-level2' }
    ]
  });
  assert.deepEqual(findings.map(({ ruleId, sourceRef }) => `${ruleId} ${sourceRef}`), ['visible-label #postcode', 'visible-label #country']);
});

test('error rules count aria-errormessage and report medium confidence', () => {
  const findings = checkInventory({
    controls: [
      { sourceRef: '#linked', type: 'email', accessibleName: 'Email', autocomplete: 'email', required: true, errorMessage: ['linked-error'], errorTextPresent: true, errorAnnounced: true },
      { sourceRef: '#quiet', type: 'email', accessibleName: 'Email', autocomplete: 'email', required: true, errorMessage: ['quiet-error'], errorTextPresent: true, errorAnnounced: false },
      { sourceRef: '#bare', type: 'email', accessibleName: 'Email', autocomplete: 'email', required: true }
    ]
  });
  assert.deepEqual(findings.map(({ ruleId, sourceRef, confidence }) => `${ruleId} ${sourceRef} ${confidence}`), [
    'error-announcement #quiet medium',
    'error-association #bare medium'
  ]);
});

test('scenario evidence records entry state as booleans without entered text', () => {
  let session = createSession('validation', inventory, '2026-07-24T00:00:00Z');
  session = recordEvidence(session, { kind: 'validation', controlRef: '#email', outcome: 'Invalid email format.', hasEntry: true, enteredText: 'person@example.test' });
  session = recordEvidence(session, { kind: 'retention', controlRef: '#email', outcome: 'Entry remained after failure.', retained: true });
  session = finishSession(session);
  const serialised = JSON.stringify(session);
  assert.doesNotMatch(serialised, /person@example\.test/);
  assert.equal(session.evidence[0].hasEntry, true);
  assert.equal(session.evidence[1].retained, true);
});

test('reports separate automated findings, instrumented evidence and limitations', () => {
  let session = createSession('keyboard', inventory, '2026-07-24T00:00:00Z');
  session = finishSession(recordEvidence(session, { kind: 'focus', controlRef: '#name', outcome: 'Reached first in document order.' }));
  const markdown = buildReport({ inventory, sessions: [session], notes: ['Error summary did not receive focus.'] }, 'markdown');
  assert.match(markdown, /Automated findings/);
  assert.match(markdown, /instrumented observation/);
  assert.match(markdown, /does not certify accessibility/i);
  assert.match(markdown, /Error summary did not receive focus/);
});

test('reports list source warnings in JSON and Markdown', () => {
  const warned = { ...structuredClone(inventory), sourceWarnings: ['2 forms were found; this prototype inventories the first form only.'] };
  const json = JSON.parse(buildReport({ inventory: warned, sessions: [], notes: [] }, 'json'));
  assert.deepEqual(json.inventory.sourceWarnings, warned.sourceWarnings);
  assert.match(buildReport({ inventory: warned, sessions: [], notes: [] }, 'markdown'), /### Source warnings\n\n- 2 forms were found/u);
  assert.doesNotMatch(buildReport({ inventory, sessions: [], notes: [] }, 'markdown'), /Source warnings/u);
});

test('JSON reports omit default and entered form values', () => {
  const report = buildReport({ inventory, sessions: [], notes: [] }, 'json');
  assert.doesNotMatch(report, /defaultEntryPresent/);
  assert.doesNotMatch(report, /\"value\"/);
});

test('Markdown reports escape authored structure in titles, notes and evidence', () => {
  const hostile = structuredClone(inventory);
  hostile.title = '# Unexpected heading';
  let session = createSession('keyboard', hostile, '2026-07-24T00:00:00Z');
  session = finishSession(recordEvidence(session, { kind: 'observation', outcome: '[link](javascript:alert(1))' }));
  const report = buildReport({ inventory: hostile, sessions: [session], notes: ['# note\n- item'] }, 'markdown');
  assert.match(report, /^# \\# Unexpected heading/m);
  assert.doesNotMatch(report, /^# note/m);
  assert.doesNotMatch(report, /\[link\]\(javascript:/);
});
