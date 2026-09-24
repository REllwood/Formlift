<div align="center">

# Formlift

**Rehearse a web form as a user journey, then fix the moments that block completion.**

[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4e?style=flat-square)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-43853d?style=flat-square&logo=node.js&logoColor=white)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-555?style=flat-square)

</div>

Forms lose people in small ways: a field with no label, an error message a screen reader never announces, a slow submit that throws away what someone typed. Formlift takes a form's HTML, checks it, and walks you through it the way a user would, by keyboard, through validation errors and through a slow submit, so you can see where someone would give up.

## What it does

- Checks form HTML for accessible names, groups, autocomplete and error relationships
- Rebuilds the form as a safe local copy to rehearse on
- Guides keyboard, error-recovery and optional slow-submit runs
- Records whether values were present or kept, never the values themselves
- Keeps your observation notes per form in the browser, where you can delete them
- Exports a Markdown or JSON report with the evidence

## Quick start

Requires Node.js 22 or newer. No `npm install` needed.

```sh
git clone https://github.com/REllwood/Formlift.git
cd Formlift
npm start
```

Open http://127.0.0.1:4177, press **Load defect fixture**, then **Scan supplied form** and **Prepare rehearsal**. Paste your own form's HTML in place of the fixture when you're ready.

## Status

v0.1 works on form HTML you paste in. It doesn't inspect a live tab or intercept real submissions, and it isn't an accessibility certification. Next up are Playwright export and mobile keyboard rehearsal.

## Development

```sh
npm test        # core, server and browser tests
npm run check   # tests plus syntax checks
```

The browser tests drive the app in Chromium through [Playwright](https://playwright.dev). Playwright isn't a dependency, so the browser tests are skipped when it isn't installed. To run them:

```sh
npm install --no-save playwright
npx playwright install chromium
npm test
```

## License

[MIT](LICENSE)
