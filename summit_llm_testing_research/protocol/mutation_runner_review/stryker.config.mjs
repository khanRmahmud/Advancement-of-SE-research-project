
/*
 * Summit LLM Unit Test Generation Research
 *
 * StrykerJS configuration
 *
 * Three available test suites:
 *
 *   smoke    = manually written infrastructure test
 *   baseline = GPT-generated code-only tests
 *   guided   = GPT-generated specification-guided tests
 *
 * The SAME application source and mutation target
 * are used for all three suites.
 *
 * Baseline and guided mutation results are saved
 * into separate report directories.
 *
 * This configuration does not call the GPT API.
 */

import { readFileSync } from 'node:fs';


// ============================================================
// STEP 1: Select which test suite to execute
// ============================================================

const arm = process.env.SUMMIT_TEST_ARM || 'smoke';

const validArms = ['smoke', 'baseline', 'guided'];

if (!validArms.includes(arm)) {
  throw new Error(
    `Invalid SUMMIT_TEST_ARM: ${arm}. ` +
    'Choose smoke, baseline, or guided.'
  );
}


// ============================================================
// STEP 2: Select the experiment trial
// ============================================================

const trial = Number(process.env.SUMMIT_TRIAL || '2');

if (!Number.isInteger(trial) || trial < 1) {
  throw new Error(
    'SUMMIT_TRIAL must be a positive integer.'
  );
}

const trialLabel = String(trial).padStart(2, '0');


// ============================================================
// STEP 3: Identify the source file to mutate
// ============================================================

const sourceFile = 'src/posts/posts.service.ts';

const sourceCode = readFileSync(
  new URL('./src/posts/posts.service.ts', import.meta.url),
  'utf8'
);

const lines = sourceCode.split(/\r?\n/);


// ============================================================
// STEP 4: Locate removePostService()
//
// This ensures we mutate only the chosen function,
// not the entire posts.service.ts file.
// ============================================================

const startIndex = lines.findIndex((line) =>
  /^\s*export\s+async\s+function\s+removePostService\s*\(/.test(line)
);

if (startIndex === -1) {
  throw new Error(
    'removePostService() was not found.'
  );
}

const nextFunctionIndex = lines.findIndex(
  (line, index) =>
    index > startIndex &&
    /^\s*export\s+async\s+function\s+/.test(line)
);

const startLine = startIndex + 1;

const endLine = (
  nextFunctionIndex === -1
    ? lines.length
    : nextFunctionIndex
);

const mutationTarget = (
  `${sourceFile}:${startLine}-${endLine}`
);


// ============================================================
// STEP 5: Select the exact unit test file
// ============================================================

let testCommand;

if (arm === 'smoke') {

  // Human-written infrastructure test.
  // NOT included in final experimental comparisons.

  testCommand = (
    'node --experimental-test-module-mocks ' +
    '--test tests/unit/remove-post.smoke.mjs'
  );

} else {

  // Generated TypeScript tests will be compiled to dist/.
  // Execute only the selected experimental test file.

  const testFile = (
    `dist/posts/posts.service.${arm}.r${trialLabel}.test.js`
  );

  testCommand = (
    'node --experimental-test-module-mocks ' +
    `--test ${testFile}`
  );

}


// ============================================================
// STEP 6: Separate reports by method and trial
// ============================================================

const runLabel = (
  arm === 'smoke'
    ? 'infrastructure-smoke'
    : `${arm}-trial${trialLabel}`
);

const reportFolder = `reports/mutation/${runLabel}`;


// ============================================================
// STEP 7: Configure StrykerJS
// ============================================================

const config = {

  // Source code to mutate.
  mutate: [
    mutationTarget
  ],

  // Run tests using a terminal command.
  testRunner: 'command',

  // The command runner does not provide
  // per-test coverage optimization.
  coverageAnalysis: 'off',

  // Recompile the mutated TypeScript.
  buildCommand: 'npm run build',

  // Run only the selected test suite.
  commandRunner: {
    command: testCommand
  },

  // Use one worker for reproducibility and
  // easier debugging.
  concurrency: 1,

  // Produce terminal and file-based results.
  reporters: [
    'clear-text',
    'progress',
    'html',
    'json'
  ],

  // Save HTML output separately.
  htmlReporter: {
    fileName: `${reportFolder}/mutation.html`
  },

  // Save JSON output separately.
  jsonReporter: {
    fileName: `${reportFolder}/mutation.json`
  },

  // Pilot thresholds; do not fail solely
  // because of a low mutation score.
  thresholds: {
    high: 80,
    low: 60,
    break: null
  },

  timeoutMS: 10000,

  logLevel: 'info'

};

export default config;
