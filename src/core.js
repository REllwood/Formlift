export const MAX_CONTROLS = 120;
const allowedTypes = new Set(['button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset', 'search', 'select', 'submit', 'tel', 'text', 'textarea', 'time', 'url', 'week']);
const autocompleteRelevant = new Set(['email', 'tel', 'text', 'password']);

function text(value, maximum = 500) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').slice(0, maximum) : '';
}

export function validateInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A form inventory object is required.');
  if (!Array.isArray(value.controls)) throw new TypeError('Form controls must be an array.');
  if (value.controls.length === 0) throw new RangeError('The selected form has no supported controls.');
  if (value.controls.length > MAX_CONTROLS) throw new RangeError(`A rehearsal is limited to ${MAX_CONTROLS} controls.`);
  const references = new Set();
  const controls = value.controls.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') throw new TypeError(`Control ${index + 1} is invalid.`);
    const sourceRef = text(candidate.sourceRef, 160) || `control-${index + 1}`;
    const reference = references.has(sourceRef) ? `${sourceRef}-${index + 1}` : sourceRef;
    references.add(reference);
    const type = allowedTypes.has(candidate.type) ? candidate.type : 'text';
    return {
      reference,
      sourceRef,
      element: text(candidate.element, 20) || 'input',
      type,
      accessibleName: text(candidate.accessibleName, 300),
      nameSource: text(candidate.nameSource, 80),
      required: Boolean(candidate.required),
      disabled: Boolean(candidate.disabled),
      autocomplete: text(candidate.autocomplete, 120),
      describedBy: Array.isArray(candidate.describedBy) ? candidate.describedBy.map((item) => text(item, 160)).filter(Boolean).slice(0, 20) : [],
      errorMessage: Array.isArray(candidate.errorMessage) ? candidate.errorMessage.map((item) => text(item, 160)).filter(Boolean).slice(0, 20) : [],
      errorTextPresent: Boolean(candidate.errorTextPresent),
      errorAnnounced: Boolean(candidate.errorAnnounced),
      groupName: text(candidate.groupName, 120),
      groupLabel: text(candidate.groupLabel, 300),
      sensitive: type === 'password' || Boolean(candidate.sensitive),
      defaultEntryPresent: Boolean(candidate.defaultEntryPresent),
      options: Array.isArray(candidate.options)
        ? candidate.options.map((item) => text(item, 200)).filter(Boolean).slice(0, 50)
        : []
    };
  });
  return {
    version: 1,
    formReference: text(value.formReference, 160) || 'form-1',
    title: text(value.title, 160) || 'Untitled supplied form',
    controls,
    hasLiveRegion: Boolean(value.hasLiveRegion),
    hasProgressText: Boolean(value.hasProgressText),
    sourceWarnings: Array.isArray(value.sourceWarnings) ? value.sourceWarnings.map((item) => text(item, 400)).filter(Boolean).slice(0, 30) : []
  };
}

function finding(ruleId, control, consequence, evidence, severity = 'moderate', confidence = 'high') {
  return {
    id: `${ruleId}:${control.reference}`,
    ruleId,
    controlRef: control.reference,
    sourceRef: control.sourceRef,
    origin: 'automated',
    severity,
    confidence,
    consequence,
    evidence
  };
}

export function checkInventory(value) {
  const inventory = validateInventory(value);
  const findings = [];
  for (const control of inventory.controls) {
    if (control.type === 'hidden') continue;
    if (!control.accessibleName) {
      findings.push(finding(
        'accessible-name',
        control,
        'A keyboard or screen-reader user may not know what this control requests.',
        `${control.sourceRef} has no accessible name from a label, ARIA reference, button text or alternative text.`,
        'high'
      ));
    } else if (['title', 'placeholder'].includes(control.nameSource)) {
      findings.push(finding(
        'visible-label',
        control,
        'A placeholder or tooltip disappears while someone types or may never be shown, so the question is easy to lose.',
        `${control.sourceRef} is named only by its ${control.nameSource} attribute.`
      ));
    }
    // Static HTML can't show relationships a script adds when an error appears, so these two rules are medium confidence.
    if (control.required && control.describedBy.length === 0 && control.errorMessage.length === 0) {
      findings.push(finding(
        'error-association',
        control,
        'A validation message may not be programmatically connected to the field it explains.',
        `${control.sourceRef} is required and the supplied HTML has no aria-describedby or aria-errormessage reference for it. A script may add one when an error appears, so confirm this during the validation rehearsal.`,
        'moderate',
        'medium'
      ));
    } else if (control.required && control.errorTextPresent && !control.errorAnnounced) {
      findings.push(finding(
        'error-announcement',
        control,
        'An error may appear visually without being announced when it changes.',
        `${control.sourceRef} is described by text that isn't in an alert, status or live region. If that text is where errors appear, a change to it won't be announced.`,
        'moderate',
        'medium'
      ));
    }
    if (autocompleteRelevant.has(control.type) && !control.autocomplete && !['search'].includes(control.type)) {
      findings.push(finding(
        'autocomplete',
        control,
        'The browser may be less able to help a user enter familiar information.',
        `${control.sourceRef} has no autocomplete token.`,
        'low',
        'medium'
      ));
    }
    if (control.type === 'radio' && (!control.groupName || !control.groupLabel)) {
      findings.push(finding(
        'radio-group',
        control,
        'The relationship and shared question between radio options may be unclear.',
        `${control.sourceRef} is not in a named and labelled group.`
      ));
    }
  }
  const submit = inventory.controls.find((control) => ['submit', 'image'].includes(control.type));
  if (submit && !inventory.hasLiveRegion && !inventory.hasProgressText) {
    findings.push(finding(
      'submit-progress',
      submit,
      'A user may receive no confirmation that a slow submission is still in progress.',
      'No static progress text or live status region was found in the supplied form.',
      'moderate',
      'medium'
    ));
  }
  return findings;
}

export const SCENARIOS = Object.freeze([
  {
    id: 'keyboard',
    name: 'Keyboard path',
    steps: ['Prepare a value-free rehearsal surface.', 'Move focus through every enabled control in document order.', 'Record focus sequence and any control that cannot be reached.', 'Stop and clear rehearsal entries.']
  },
  {
    id: 'validation',
    name: 'Validation recovery',
    steps: ['Prepare required controls without entries.', 'Trigger local constraint validation.', 'Observe focus movement and error associations.', 'Enter synthetic test data, retry and clear all entries.']
  },
  {
    id: 'slow-submit',
    name: 'Slow submit',
    steps: ['Confirm this is a local or test-only rehearsal.', 'Inject a disclosed three-second local delay.', 'Observe submit disabled state and progress messaging.', 'Optionally simulate a failed response, record retention as booleans and clear all entries.']
  }
]);

export function createSession(scenarioId, inventoryValue, now = new Date().toISOString()) {
  const inventory = validateInventory(inventoryValue);
  const scenario = SCENARIOS.find(({ id }) => id === scenarioId);
  if (!scenario) throw new RangeError('Unknown rehearsal scenario.');
  return {
    version: 1,
    id: `${scenarioId}:${now}`,
    scenarioId,
    scenarioName: scenario.name,
    startedAt: now,
    status: 'active',
    currentStep: 0,
    evidence: [],
    inventoryReference: inventory.formReference
  };
}

export function recordEvidence(session, candidate) {
  if (!session || session.status !== 'active') throw new RangeError('Evidence requires an active rehearsal.');
  const allowedKinds = new Set(['focus', 'validation', 'announcement', 'submit', 'retention', 'observation']);
  if (!candidate || !allowedKinds.has(candidate.kind)) throw new RangeError('Unsupported evidence kind.');
  const entry = {
    id: `${session.id}:e${session.evidence.length + 1}`,
    kind: candidate.kind,
    controlRef: text(candidate.controlRef, 160),
    outcome: text(candidate.outcome, 500),
    hasEntry: typeof candidate.hasEntry === 'boolean' ? candidate.hasEntry : null,
    retained: typeof candidate.retained === 'boolean' ? candidate.retained : null,
    source: candidate.source === 'human' ? 'human observation' : 'instrumented observation',
    recordedAt: text(candidate.recordedAt, 80) || new Date().toISOString()
  };
  return { ...session, evidence: [...session.evidence, entry], currentStep: Math.min(session.currentStep + 1, 3) };
}

export function finishSession(session, incomplete = false, now = new Date().toISOString()) {
  if (!session) throw new TypeError('A session is required.');
  return { ...session, status: incomplete ? 'stopped with incomplete evidence' : 'complete', finishedAt: now };
}

function reportObject(project) {
  const inventory = validateInventory(project.inventory);
  const findings = checkInventory(inventory);
  const sessions = Array.isArray(project.sessions) ? project.sessions.map((session) => ({
    scenarioName: text(session.scenarioName, 120),
    status: text(session.status, 80),
    startedAt: text(session.startedAt, 80),
    finishedAt: text(session.finishedAt, 80),
    evidence: Array.isArray(session.evidence) ? session.evidence.map((entry) => ({
      kind: text(entry.kind, 40),
      controlRef: text(entry.controlRef, 160),
      outcome: text(entry.outcome, 500),
      hasEntry: typeof entry.hasEntry === 'boolean' ? entry.hasEntry : null,
      retained: typeof entry.retained === 'boolean' ? entry.retained : null,
      source: text(entry.source, 80)
    })) : []
  })) : [];
  const notes = Array.isArray(project.notes) ? project.notes.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 1_000)).slice(0, 100) : [];
  return {
    version: 1,
    title: inventory.title,
    scope: 'Supplied form structure and local rehearsal only',
    limitation: 'This evidence does not certify accessibility and does not replace testing with assistive-technology users.',
    inventory: {
      formReference: inventory.formReference,
      controlCount: inventory.controls.length,
      sourceWarnings: inventory.sourceWarnings,
      controls: inventory.controls.map(({ reference, sourceRef, element, type, accessibleName, nameSource, required, disabled, autocomplete, describedBy, errorMessage, errorTextPresent, errorAnnounced, groupName, groupLabel, sensitive }) => ({
        reference, sourceRef, element, type, accessibleName, nameSource, required, disabled, autocomplete, describedBy, errorMessage, errorTextPresent, errorAnnounced, groupName, groupLabel, sensitive
      }))
    },
    findings,
    sessions,
    notes
  };
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/([\\`*_{}\[\]()<>#+.!|>-])/gu, '\\$1');
}

export function buildReport(project, format = 'json') {
  const report = reportObject(project);
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format !== 'markdown') throw new RangeError('Unsupported report format.');
  const lines = [
    `# ${escapeMarkdown(report.title)}`,
    '',
    report.scope,
    '',
    report.limitation,
    '',
    '## Form inventory',
    '',
    `${report.inventory.controlCount} supported ${report.inventory.controlCount === 1 ? 'control was' : 'controls were'} inventoried. Entered and default values are excluded.`,
    ''
  ];
  report.inventory.controls.forEach((control) => lines.push(`- ${escapeMarkdown(control.sourceRef)}: ${escapeMarkdown(control.type)}; name ${control.accessibleName ? `“${escapeMarkdown(control.accessibleName)}” from ${escapeMarkdown(control.nameSource || 'available text')}` : 'not found'}; required ${control.required ? 'yes' : 'no'}.`));
  if (report.inventory.sourceWarnings.length) {
    lines.push('', '### Source warnings', '');
    report.inventory.sourceWarnings.forEach((warning) => lines.push(`- ${escapeMarkdown(warning)}`));
  }
  lines.push('', '## Automated findings', '');
  if (report.findings.length === 0) lines.push('No findings from the focused rule set. Manual and assistive-technology testing is still required.');
  report.findings.forEach((item) => lines.push(`### ${escapeMarkdown(item.ruleId)} at ${escapeMarkdown(item.sourceRef)}`, '', `Severity: ${escapeMarkdown(item.severity)}. Confidence: ${escapeMarkdown(item.confidence)}. Origin: ${escapeMarkdown(item.origin)}.`, '', escapeMarkdown(item.consequence), '', `Evidence: ${escapeMarkdown(item.evidence)}`, ''));
  lines.push('## Journey evidence', '');
  if (report.sessions.length === 0) lines.push('No rehearsal evidence recorded.');
  for (const session of report.sessions) {
    lines.push(`### ${escapeMarkdown(session.scenarioName)}`, '', `Status: ${escapeMarkdown(session.status)}.`, '');
    session.evidence.forEach((entry) => lines.push(`- ${escapeMarkdown(entry.source)}: ${escapeMarkdown(entry.controlRef || 'form')} — ${escapeMarkdown(entry.outcome)}${entry.hasEntry === null ? '' : ` Entry present: ${entry.hasEntry ? 'yes' : 'no'}.`}${entry.retained === null ? '' : ` Retained after failure: ${entry.retained ? 'yes' : 'no'}.`}`));
    lines.push('');
  }
  lines.push('## Human notes', '');
  if (report.notes.length === 0) lines.push('- No human observations recorded.');
  else report.notes.forEach((note) => lines.push(`- ${escapeMarkdown(note)}`));
  return lines.join('\n').trim();
}
