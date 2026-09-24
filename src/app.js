import {
  SCENARIOS,
  buildReport,
  checkInventory,
  createSession,
  finishSession,
  recordEvidence,
  validateInventory
} from './core.js';

const noteStorageKey = 'formlift:notes:v0.1';
const fixture = `<form id="synthetic-account" aria-labelledby="account-heading">
  <h2 id="account-heading">Create a synthetic test account</h2>
  <label for="display-name">Display name</label>
  <input id="display-name" name="displayName" required>
  <input id="email" name="email" type="email" required autocomplete="email" aria-describedby="email-error">
  <label for="password">Test password</label>
  <input id="password" name="password" type="password" required autocomplete="new-password">
  <p id="email-error">Enter a test email address.</p>
  <div>
    <span>Contact preference</span>
    <input id="contact-email" type="radio" name="contact"><label for="contact-email">Email</label>
    <input id="contact-phone" type="radio" name="contact"><label for="contact-phone">Phone</label>
  </div>
  <button type="submit">Create test account</button>
</form>`;

const elements = {
  source: document.querySelector('#html-source'),
  file: document.querySelector('#html-file'),
  status: document.querySelector('#job-status'),
  cancel: document.querySelector('#cancel-job'),
  dialogStatus: document.querySelector('#dialog-job-status'),
  dialogCancel: document.querySelector('#dialog-cancel-job'),
  empty: document.querySelector('#empty-state'),
  project: document.querySelector('#project'),
  scenarioControls: document.querySelector('#scenario-controls'),
  scenarioSelect: document.querySelector('#scenario-select'),
  stopScenario: document.querySelector('#stop-scenario'),
  inventorySummary: document.querySelector('#inventory-summary'),
  form: document.querySelector('#rehearsal-form'),
  coach: document.querySelector('#scenario-coach'),
  findings: document.querySelector('#findings'),
  timeline: document.querySelector('#timeline'),
  noteForm: document.querySelector('#note-form'),
  noteInput: document.querySelector('#note-input'),
  noteList: document.querySelector('#note-list'),
  dialog: document.querySelector('#report-dialog'),
  reportContent: document.querySelector('#report-content')
};

let inventory = null;
let findings = [];
let sessions = [];
let notes = [];
let activeSession = null;
let activeController = null;
let focusIndex = -1;

function setStatus(message, loading = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('loading', loading);
  elements.cancel.hidden = !loading;
  elements.dialogStatus.textContent = message;
  elements.dialogStatus.classList.toggle('loading', loading);
  elements.dialogStatus.hidden = !elements.dialog.open && !loading;
  elements.dialogCancel.hidden = !loading;
}

async function runJob(label, work) {
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  setStatus(`Loading: ${label}`, true);
  try {
    const value = await work(controller.signal);
    setStatus(`${label} complete.`);
    return value;
  } catch (error) {
    setStatus(error.name === 'AbortError' ? `${label} stopped. Rehearsal entries were cleared.` : `${label} failed: ${error.message}`);
    return null;
  } finally {
    if (activeController === controller) activeController = null;
  }
}

function wait(milliseconds, signal, progress) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const interval = window.setInterval(() => progress(Math.min(1, (performance.now() - started) / milliseconds)), 100);
    const timer = window.setTimeout(() => {
      window.clearInterval(interval);
      progress(1);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      reject(new DOMException('Stopped', 'AbortError'));
    }, { once: true });
  });
}

function controlFreeText(node) {
  if (!node || node.matches?.('input, select, textarea')) return '';
  const copy = node.cloneNode(true);
  copy.querySelectorAll?.('input, select, textarea, button').forEach((control) => control.remove());
  return copy.textContent?.trim().replace(/\s+/gu, ' ') || '';
}

function referencedText(parsed, references) {
  return references.map((reference) => controlFreeText(parsed.getElementById(reference))).filter(Boolean).join(' ');
}

function extractInventory(html) {
  if (typeof html !== 'string' || html.length > 250_000) throw new RangeError('Supplied HTML is limited to 250,000 characters.');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const forms = [...parsed.querySelectorAll('form')];
  if (forms.length === 0) throw new RangeError('No form element was found in the supplied HTML.');
  const form = forms[0];
  const sourceWarnings = forms.length > 1 ? [`${forms.length} forms were found; this prototype inventories the first form only.`] : [];
  const controls = [...form.querySelectorAll('input, select, textarea, button')].map((control, index) => {
    const tag = control.tagName.toLocaleLowerCase('en-AU');
    const rawType = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : tag === 'button' ? (control.getAttribute('type') || 'submit').toLocaleLowerCase('en-AU') : (control.getAttribute('type') || 'text').toLocaleLowerCase('en-AU');
    const id = control.getAttribute('id') || '';
    const sourceRef = id ? `#${id}` : `${tag}:nth-control(${index + 1})`;
    let accessibleName = '';
    let nameSource = '';
    const ariaLabel = control.getAttribute('aria-label')?.trim();
    if (ariaLabel) {
      accessibleName = ariaLabel;
      nameSource = 'aria-label';
    }
    if (!accessibleName) {
      const references = (control.getAttribute('aria-labelledby') || '').trim().split(/\s+/u).filter(Boolean);
      const label = referencedText(parsed, references);
      if (label) {
        accessibleName = label;
        nameSource = 'aria-labelledby';
      }
    }
    if (!accessibleName && id) {
      const label = [...form.querySelectorAll('label')].find((candidate) => candidate.htmlFor === id);
      const labelText = controlFreeText(label);
      if (labelText) {
        accessibleName = labelText;
        nameSource = 'label[for]';
      }
    }
    if (!accessibleName) {
      const wrapping = control.closest('label');
      const wrappingText = controlFreeText(wrapping);
      if (wrappingText) {
        accessibleName = wrappingText;
        nameSource = 'wrapping label';
      }
    }
    if (!accessibleName && tag === 'button' && control.textContent?.trim()) {
      accessibleName = control.textContent.trim();
      nameSource = 'button text';
    }
    const describedIds = (control.getAttribute('aria-describedby') || '').trim().split(/\s+/u).filter(Boolean);
    const describedNodes = describedIds.map((reference) => parsed.getElementById(reference)).filter(Boolean);
    const group = control.closest('fieldset, [role="radiogroup"]');
    const groupReferences = (group?.getAttribute('aria-labelledby') || '').trim().split(/\s+/u).filter(Boolean);
    const groupLabel = controlFreeText(group?.querySelector(':scope > legend')) || group?.getAttribute('aria-label')?.trim() || referencedText(parsed, groupReferences);
    return {
      sourceRef,
      element: tag,
      type: rawType,
      accessibleName,
      nameSource,
      required: control.hasAttribute('required') || control.getAttribute('aria-required') === 'true',
      disabled: control.hasAttribute('disabled'),
      autocomplete: control.getAttribute('autocomplete') || '',
      describedBy: describedIds,
      errorTextPresent: describedNodes.some((node) => Boolean(node.textContent?.trim())),
      errorAnnounced: describedNodes.some((node) => node.getAttribute('role') === 'alert' || Boolean(node.closest('[aria-live]')) || Boolean(node.getAttribute('aria-live'))),
      groupName: control.getAttribute('name') || '',
      groupLabel,
      sensitive: rawType === 'password' || /card|payment|cvv|cvc/iu.test(`${control.getAttribute('name') || ''} ${id}`),
      defaultEntryPresent: control.hasAttribute('value') || control.hasAttribute('checked') || (tag === 'textarea' && Boolean(control.textContent)) || (tag === 'select' && Boolean(control.querySelector('option[selected]'))),
      options: tag === 'select' ? [...control.querySelectorAll('option')].map((option) => controlFreeText(option)).filter(Boolean) : []
    };
  });
  const titleReference = (form.getAttribute('aria-labelledby') || '').split(/\s+/u).find(Boolean);
  return validateInventory({
    formReference: form.id ? `#${form.id}` : 'form:nth-of-type(1)',
    title: titleReference ? parsed.getElementById(titleReference)?.textContent : form.getAttribute('aria-label'),
    controls,
    hasLiveRegion: Boolean(form.querySelector('[role="status"], [role="alert"], [aria-live]')),
    hasProgressText: [...form.querySelectorAll('button, p, div, span')].some((node) => /submitting|loading|please wait|in progress/iu.test(node.textContent || '')),
    sourceWarnings
  });
}

function renderFindings() {
  elements.findings.replaceChildren();
  if (findings.length === 0) {
    const text = document.createElement('p');
    text.textContent = 'The focused structural rule set found no issue. This is not a certification; complete the rehearsals and test with assistive technologies.';
    elements.findings.append(text);
    return;
  }
  for (const item of findings) {
    const article = document.createElement('article');
    article.className = `finding ${item.severity}`;
    const heading = document.createElement('h3');
    heading.textContent = `${item.ruleId} at ${item.sourceRef}`;
    const meta = document.createElement('div');
    meta.className = 'finding-meta';
    meta.textContent = `${item.severity} severity · ${item.confidence} confidence · ${item.origin}`;
    const consequence = document.createElement('p');
    consequence.textContent = item.consequence;
    const evidence = document.createElement('p');
    evidence.textContent = item.evidence;
    article.append(heading, meta, consequence, evidence);
    elements.findings.append(article);
  }
}

function safeControl(control, index) {
  const container = document.createElement('div');
  container.className = 'rehearsal-field';
  if (control.type === 'hidden') {
    const text = document.createElement('p');
    text.textContent = `${control.sourceRef}: hidden control omitted from rehearsal.`;
    container.append(text);
    return container;
  }
  const safeId = `rehearsal-${index + 1}`;
  const label = document.createElement('label');
  label.htmlFor = safeId;
  label.textContent = control.accessibleName || `Unlabelled ${control.type} control`;
  if (!control.accessibleName) label.className = 'unlabelled';
  let field;
  if (control.type === 'select') {
    field = document.createElement('select');
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Choose a synthetic option';
    field.append(option);
    const labels = control.options.length ? control.options : ['Synthetic option'];
    labels.forEach((optionLabel, optionIndex) => {
      const safeOption = document.createElement('option');
      safeOption.value = `synthetic-${optionIndex + 1}`;
      safeOption.textContent = optionLabel;
      field.append(safeOption);
    });
  } else if (control.type === 'textarea') {
    field = document.createElement('textarea');
    field.rows = 3;
  } else if (control.element === 'button' || ['submit', 'button', 'reset'].includes(control.type)) {
    field = document.createElement('button');
    field.type = control.type === 'reset' ? 'button' : control.type;
    field.textContent = control.accessibleName || `Unlabelled ${control.type} button`;
  } else {
    field = document.createElement('input');
    field.type = ['email', 'tel', 'url', 'number', 'date', 'password', 'checkbox', 'radio', 'file'].includes(control.type) ? control.type : 'text';
  }
  if (control.type === 'radio') field.name = `rehearsal-${control.groupName || control.reference}`;
  field.id = safeId;
  field.dataset.controlRef = control.reference;
  field.disabled = control.disabled;
  if ('required' in field) field.required = control.required;
  if ('autocomplete' in field) field.autocomplete = 'off';
  const reference = document.createElement('span');
  reference.className = 'source-ref';
  reference.textContent = `${control.sourceRef}; imported default entry omitted${control.sensitive ? '; sensitive role' : ''}.`;
  container.append(label, field, reference);
  return container;
}

function renderForm() {
  elements.form.replaceChildren();
  const radioGroups = new Map();
  inventory.controls.forEach((control, index) => {
    if (control.type !== 'radio') {
      elements.form.append(safeControl(control, index));
      return;
    }
    const key = control.groupName || `ungrouped-${control.reference}`;
    let group = radioGroups.get(key);
    if (!group) {
      group = document.createElement('fieldset');
      group.className = 'rehearsal-radio-group';
      const legend = document.createElement('legend');
      legend.textContent = control.groupLabel || `Unlabelled radio group: ${control.groupName || control.sourceRef}`;
      group.append(legend);
      radioGroups.set(key, group);
      elements.form.append(group);
    }
    group.append(safeControl(control, index));
  });
  elements.form.addEventListener('submit', (event) => event.preventDefault(), { once: false });
}

function renderTimeline() {
  elements.timeline.replaceChildren();
  const evidence = sessions.flatMap((session) => session.evidence ?? []);
  if (!evidence.length) {
    const item = document.createElement('li');
    item.textContent = 'No journey evidence recorded.';
    elements.timeline.append(item);
    return;
  }
  for (const entry of evidence) {
    const item = document.createElement('li');
    item.textContent = `${entry.source}: ${entry.controlRef || 'form'} — ${entry.outcome}${entry.hasEntry === null ? '' : ` Entry present: ${entry.hasEntry ? 'yes' : 'no'}.`}${entry.retained === null ? '' : ` Retained: ${entry.retained ? 'yes' : 'no'}.`}`;
    elements.timeline.append(item);
  }
}

function loadNotes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(noteStorageKey) ?? '[]');
    notes = Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string').map((item) => item.slice(0, 1000)).slice(0, 100) : [];
  } catch {
    notes = [];
  }
  renderNotes();
}

function renderNotes() {
  elements.noteList.replaceChildren();
  notes.forEach((note) => {
    const item = document.createElement('li');
    item.textContent = note;
    elements.noteList.append(item);
  });
}

// Checkbox and radio inputs report value "on" even when unchecked, so entry state depends on the control type.
function hasEntry(field) {
  if (field instanceof HTMLInputElement) {
    if (['checkbox', 'radio'].includes(field.type)) return field.checked;
    if (field.type === 'file') return (field.files?.length ?? 0) > 0;
    return field.value !== '';
  }
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) return field.value !== '';
  return false;
}

function entryFields() {
  return [...elements.form.querySelectorAll('input[data-control-ref], select[data-control-ref], textarea[data-control-ref]')];
}

function clearEntries() {
  elements.form.reset();
  for (const field of elements.form.elements) {
    if (field instanceof HTMLInputElement) {
      if (['checkbox', 'radio'].includes(field.type)) field.checked = false;
      else field.value = '';
    } else if (field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) field.value = '';
  }
}

function finishActive(incomplete) {
  activeController?.abort();
  if (activeSession) {
    activeSession = finishSession(activeSession, incomplete);
    sessions = [...sessions.filter(({ id }) => id !== activeSession.id), activeSession];
  }
  clearEntries();
  activeSession = null;
  focusIndex = -1;
  elements.coach.hidden = true;
  elements.stopScenario.hidden = true;
  renderTimeline();
}

function record(candidate) {
  activeSession = recordEvidence(activeSession, { ...candidate, recordedAt: new Date().toISOString() });
  sessions = [...sessions.filter(({ id }) => id !== activeSession.id), activeSession];
  renderTimeline();
}

function coachBase(title, text) {
  elements.coach.replaceChildren();
  elements.coach.hidden = false;
  const heading = document.createElement('h3');
  heading.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  const actions = document.createElement('div');
  actions.className = 'coach-actions';
  elements.coach.append(heading, paragraph, actions);
  return actions;
}

function keyboardCoach() {
  const controls = [...elements.form.querySelectorAll('[data-control-ref]')].filter((field) => !field.disabled && field.type !== 'hidden');
  const actions = coachBase('Keyboard path', 'Move focus in reconstructed document order. Confirm whether the highlighted control matches the expected next stop.');
  const next = document.createElement('button');
  next.type = 'button';
  next.textContent = 'Move to next control';
  next.addEventListener('click', () => {
    focusIndex += 1;
    if (focusIndex >= controls.length) {
      record({ kind: 'observation', outcome: `Reached all ${controls.length} enabled reconstructed controls in document order.` });
      finishActive(false);
      setStatus('Keyboard-path rehearsal complete. All rehearsal entries were cleared.');
      return;
    }
    const field = controls[focusIndex];
    field.focus();
    record({ kind: 'focus', controlRef: field.dataset.controlRef, outcome: `Focus moved to position ${focusIndex + 1} of ${controls.length}.` });
  });
  actions.append(next);
}

function validationCoach() {
  const actions = coachBase('Validation recovery', 'Leave required controls blank, then trigger local constraint validation. Evidence records only whether an entry exists, never its text.');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = 'Trigger local validation';
  trigger.addEventListener('click', () => {
    const fields = [...elements.form.elements].filter((field) => typeof field.checkValidity === 'function' && !field.checkValidity());
    fields.forEach((field) => record({
      kind: 'validation',
      controlRef: field.dataset.controlRef,
      outcome: 'Local constraint validation identified this control as invalid.',
      hasEntry: hasEntry(field)
    }));
    if (fields[0]) {
      fields[0].focus();
      record({ kind: 'focus', controlRef: fields[0].dataset.controlRef, outcome: 'Rehearsal moved focus to the first invalid control; compare this with the supplied form behaviour.' });
    } else record({ kind: 'validation', outcome: 'No local validation errors were triggered. Evidence is incomplete for this scenario.' });
  });
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Record retry and finish';
  retry.addEventListener('click', () => {
    const invalid = [...elements.form.elements].filter((field) => typeof field.checkValidity === 'function' && !field.checkValidity());
    record({
      kind: 'validation',
      outcome: invalid.length === 0
        ? 'A local retry passed constraint validation.'
        : `A local retry still had ${invalid.length} invalid reconstructed controls; evidence is incomplete.`
    });
    finishActive(invalid.length > 0);
    setStatus(`Validation-recovery rehearsal ${invalid.length === 0 ? 'complete' : 'stopped with incomplete evidence'}. All rehearsal entries were cleared.`);
  });
  actions.append(trigger, retry);
}

async function slowSubmitCoach() {
  const actions = coachBase('Slow submit', 'This injects a local three-second delay into the reconstructed form only. It does not contact or alter a source page.');
  const optionLabel = document.createElement('label');
  const option = document.createElement('input');
  option.type = 'checkbox';
  optionLabel.append(option, document.createTextNode(' Simulate a failed response that clears rehearsal entries'));
  const progress = document.createElement('div');
  progress.className = 'progress-track';
  const bar = document.createElement('span');
  progress.append(bar);
  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = 'Begin disclosed three-second delay';
  run.addEventListener('click', async () => {
    run.disabled = true;
    const submit = elements.form.querySelector('[type="submit"]');
    const hadEntries = new Map(entryFields().map((field) => [field.dataset.controlRef, hasEntry(field)]));
    const completed = await runJob('simulating slow submit on the local reconstruction', async (signal) => {
      record({ kind: 'submit', controlRef: submit?.dataset.controlRef, outcome: `Injected delay began. Supplied structure ${inventory.hasLiveRegion || inventory.hasProgressText ? 'contains' : 'does not contain'} static progress evidence.` });
      await wait(3000, signal, (value) => { bar.style.width = `${Math.round(value * 100)}%`; });
      if (option.checked) clearEntries();
      for (const [controlRef, wasPresent] of hadEntries) {
        if (!wasPresent) continue;
        const field = entryFields().find((candidate) => candidate.dataset.controlRef === controlRef);
        const retained = Boolean(field && hasEntry(field));
        record({ kind: 'retention', controlRef, outcome: retained ? 'Rehearsal entry remained after the delay.' : 'Test-only failed response cleared this rehearsal entry.', hasEntry: true, retained });
      }
      return true;
    });
    if (completed) {
      record({ kind: 'submit', controlRef: submit?.dataset.controlRef, outcome: 'Injected delay ended and local instrumentation was removed.' });
      finishActive(false);
      setStatus('Slow-submit rehearsal complete. All rehearsal entries were cleared after evidence capture.');
    } else {
      finishActive(true);
      run.disabled = false;
    }
  });
  actions.append(optionLabel, progress, run);
}

async function startScenario() {
  finishActive(true);
  const scenario = SCENARIOS.find(({ id }) => id === elements.scenarioSelect.value);
  const session = await runJob(`preparing ${scenario.name} rehearsal`, async (signal) => {
    await wait(80, signal, () => {});
    return createSession(scenario.id, inventory, new Date().toISOString());
  });
  if (!session) return;
  activeSession = session;
  sessions.push(session);
  clearEntries();
  elements.stopScenario.hidden = false;
  renderTimeline();
  if (scenario.id === 'keyboard') keyboardCoach();
  else if (scenario.id === 'validation') validationCoach();
  else slowSubmitCoach();
}

function renderProject() {
  findings = checkInventory(inventory);
  sessions = [];
  activeSession = null;
  elements.empty.hidden = true;
  elements.project.hidden = false;
  elements.scenarioControls.hidden = false;
  elements.inventorySummary.textContent = `${inventory.controls.length} controls · ${findings.length} focused automated findings · ${inventory.sourceWarnings.length} source warnings`;
  renderForm();
  renderFindings();
  renderTimeline();
}

async function scan() {
  finishActive(true);
  const result = await runJob('parsing and inventorying supplied form structure', async (signal) => {
    await wait(45, signal, () => {});
    return extractInventory(elements.source.value);
  });
  if (!result) return;
  inventory = result;
  renderProject();
  setStatus(`Inventory complete: ${inventory.controls.length} supported controls. Imported actions, scripts, resources, styles and default entries were discarded.`);
}

function download(content, extension, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `formlift-report.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
}

async function report() {
  const markdown = await runJob('building privacy-reviewed evidence report', async (signal) => {
    await wait(50, signal, () => {});
    return buildReport({ inventory, sessions, notes }, 'markdown');
  });
  if (!markdown) return;
  elements.reportContent.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'Evidence report';
  const review = document.createElement('p');
  review.textContent = 'Sensitive-data review: imported default entries and rehearsal entries are excluded. Reports contain structure, booleans for entry presence and retention, automated findings, instrumented observations and your authored notes.';
  const actions = document.createElement('div');
  actions.className = 'report-actions';
  const markdownButton = document.createElement('button');
  markdownButton.type = 'button';
  markdownButton.textContent = 'Download Markdown';
  markdownButton.addEventListener('click', async () => {
    const output = await runJob('preparing Markdown report', async (signal) => {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      return buildReport({ inventory, sessions, notes }, 'markdown');
    });
    if (output) download(output, 'md', 'text/markdown;charset=utf-8');
  });
  const jsonButton = document.createElement('button');
  jsonButton.type = 'button';
  jsonButton.textContent = 'Download JSON';
  jsonButton.addEventListener('click', async () => {
    const output = await runJob('preparing JSON report', async (signal) => {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      return buildReport({ inventory, sessions, notes }, 'json');
    });
    if (output) download(output, 'json', 'application/json;charset=utf-8');
  });
  actions.append(markdownButton, jsonButton);
  const preview = document.createElement('pre');
  preview.className = 'report-preview';
  preview.textContent = markdown;
  elements.reportContent.append(heading, review, actions, preview);
  elements.dialog.showModal();
}

for (const scenario of SCENARIOS) {
  const option = document.createElement('option');
  option.value = scenario.id;
  option.textContent = scenario.name;
  elements.scenarioSelect.append(option);
}
document.querySelector('#fixture-button').addEventListener('click', () => {
  elements.source.value = fixture;
  setStatus('Synthetic defect fixture loaded. Choose Scan supplied form.');
  elements.source.focus();
});
document.querySelector('#scan-button').addEventListener('click', scan);
elements.file.addEventListener('change', async () => {
  const file = elements.file.files?.[0];
  if (!file) return;
  const content = await runJob('reading local HTML fixture', async (signal) => {
    if (file.size > 250_000) throw new RangeError('HTML fixtures are limited to 250,000 bytes.');
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    return file.text();
  });
  if (content !== null) {
    elements.source.value = content;
    setStatus('Local fixture loaded as untrusted text. Review it, then scan the supplied form.');
  }
});
document.querySelector('#start-scenario').addEventListener('click', startScenario);
elements.stopScenario.addEventListener('click', () => {
  finishActive(true);
  setStatus('Rehearsal stopped. Timers and instrumentation were removed, and all rehearsal entries were cleared.');
});
elements.cancel.addEventListener('click', () => activeController?.abort());
elements.dialogCancel.addEventListener('click', () => activeController?.abort());
elements.noteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const note = elements.noteInput.value.trim().slice(0, 1000);
  if (!note) return;
  notes.push(note);
  elements.noteInput.value = '';
  try {
    localStorage.setItem(noteStorageKey, JSON.stringify(notes));
    setStatus('Human observation stored locally. Do not include customer data or entered field text.');
  } catch (error) {
    setStatus(`Observation remains in this page but local save failed: ${error.message}`);
  }
  renderNotes();
});
document.querySelector('#report-button').addEventListener('click', report);
document.querySelector('#data-boundary-button').addEventListener('click', () => {
  elements.reportContent.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'Data boundary';
  const text = document.createElement('p');
  text.textContent = 'This prototype parses only HTML you explicitly supply. It discards scripts, actions, remote resources, styles and default entries when reconstructing controls. Rehearsal entries stay only in live controls, are recorded as presence or retention booleans, and are cleared when a scenario stops. Only authored observation notes persist locally.';
  elements.reportContent.append(heading, text);
  elements.dialog.showModal();
});

loadNotes();
