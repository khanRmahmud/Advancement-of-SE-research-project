/**
 * StrykerJS configuration for the Summit main study (12 function targets).
 *
 * DO NOT replace the existing stryker.config.mjs: that belongs to the old pilot.
 * This file must be placed at summit/app/server/stryker.research.config.mjs.
 *
 * run_research_mutation.py supplies SUMMIT_RESEARCH_FEATURE,
 * SUMMIT_RESEARCH_TARGET, SUMMIT_RESEARCH_ARM, SUMMIT_RESEARCH_SOURCE.
 * It also stages an unchanged copy of the archived LLM-generated test and
 * the original isolated TypeScript compiler under .research-mutation-input/.
 *
 * Every mutant is recompiled from the MUTATED TypeScript inside its Stryker
 * sandbox. Precompiled unmutated .research-evaluation/dist is NOT reused.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const feature = process.env.SUMMIT_RESEARCH_FEATURE;
const target = process.env.SUMMIT_RESEARCH_TARGET;
const arm = process.env.SUMMIT_RESEARCH_ARM;
const sourceFile = process.env.SUMMIT_RESEARCH_SOURCE?.replaceAll('\\', '/');

function assertName(name, value) {
  if (!value || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`Invalid or absent ${name}: ${value ?? ''}`);
  }
}
assertName('SUMMIT_RESEARCH_FEATURE', feature);
assertName('SUMMIT_RESEARCH_TARGET', target);
if (!['baseline', 'guided'].includes(arm)) {
  throw new Error(`Invalid SUMMIT_RESEARCH_ARM: ${arm ?? ''}`);
}
if (!sourceFile || !/^src\/[A-Za-z0-9_./-]+\.ts$/.test(sourceFile) || sourceFile.includes('..')) {
  throw new Error(`Invalid SUMMIT_RESEARCH_SOURCE: ${sourceFile ?? ''}`);
}
const sourcePath = path.resolve(sourceFile);
if (!existsSync(sourcePath)) throw new Error(`Missing source: ${sourceFile}`);

// Use TypeScript's syntax tree, not a search for the next exported function.
const originalCode = readFileSync(sourcePath, 'utf8');
const source = ts.createSourceFile(sourceFile, originalCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const candidates = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === target &&
  node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
);
if (candidates.length !== 1) {
  throw new Error(`Expected exactly one exported ${target} in ${sourceFile}; found ${candidates.length}`);
}
const declaration = candidates[0];
const startLine = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
const endLine = source.getLineAndCharacterOfPosition(declaration.getEnd() - 1).line + 1;
const mutationTarget = `${sourceFile}:${startLine}-${endLine}`;

const stage = `.research-mutation-input/${feature}/${target}/${arm}`;
const stagedTest = `${stage}/generated.test.ts`;
const compiler = `${stage}/compile_archived_test.cjs`;
for (const file of [stagedTest, compiler]) {
  if (!existsSync(file)) throw new Error(`Staged evaluation input missing: ${file}`);
}

const buildDir = `.research-mutation-build/${feature}/${target}/${arm}`;
const sourceDir = path.posix.dirname(sourceFile.slice('src/'.length));
const compiledTest = `${buildDir}/dist/${sourceDir}/__research_${target}_${arm}.test.js`;

const buildCommand = [
  'node', compiler, '.', stagedTest, sourceFile,
  target, arm, buildDir,
].join(' ');
const testCommand = `node --experimental-test-module-mocks --test ${compiledTest}`;
const reports = `reports/research-mutation/${feature}/${target}/${arm}`;

// These messages appear when the config is loaded and allow an independent audit
// of which source code is mutated and which generated suite is being executed.
console.log(`RESEARCH TARGET: ${mutationTarget}`);
console.log(`RESEARCH METHOD: ${arm}`);
console.log(`RESEARCH BUILD: ${buildCommand}`);
console.log(`RESEARCH TEST: ${testCommand}`);

export default {
  mutate: [mutationTarget],
  testRunner: 'command',
  coverageAnalysis: 'off',
  buildCommand,
  commandRunner: {command: testCommand},
  concurrency: 1,
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: {fileName: `${reports}/mutation.html`},
  jsonReporter: {fileName: `${reports}/mutation.json`},
  thresholds: {high: 80, low: 60, break: null},
  timeoutMS: 10000,
  // Discard old, precompiled outputs; mutated TypeScript will be recompiled.
  // Do not ignore .research-mutation-input: sandbox needs the archived test.
  ignorePatterns: [
    '.research-evaluation',
    '.research-mutation-build',
    'dist',
    'reports',
  ],
};
