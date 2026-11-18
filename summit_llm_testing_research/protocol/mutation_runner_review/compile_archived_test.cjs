#!/usr/bin/env node
'use strict';
/*
 * Compile exactly one archived LLM-generated test suite in a virtual location
 * beside its target service module. Does not copy or edit Summit src files.
 *
 * Called by evaluate_generated_tests.py. Requires the installed backend
 * TypeScript dependency and the backend's existing tsconfig.json.
 */
const fs = require('node:fs');
const path = require('node:path');

function main() {
  const [backendArg, testArg, sourceRelArg, target, arm, outputArg] = process.argv.slice(2);
  if (!backendArg || !testArg || !sourceRelArg || !target || !arm || !outputArg) {
    console.error('Usage: node compile_archived_test.cjs <backend> <archived-test> <source-rel> <target> <arm> <output-folder>');
    process.exit(2);
  }
  const backend = path.resolve(backendArg);
  const sourcePath = path.resolve(backend, sourceRelArg);
  const testPath = path.resolve(testArg);
  const output = path.resolve(outputArg);
  const ts = require(require.resolve('typescript', {paths: [backend]}));
  const tsconfig = path.join(backend, 'tsconfig.json');
  const cfg = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (cfg.error) throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, backend, undefined, tsconfig);
  if (parsed.errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => backend,
      getNewLine: () => '\n'
    }));
  }
  if (!fs.existsSync(sourcePath) || !fs.existsSync(testPath)) {
    throw new Error('Missing target source file or archived test file.');
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(target) || !['baseline', 'guided'].includes(arm)) {
    throw new Error('Invalid target/method.');
  }

  const virtualName = `__research_${target}_${arm}.test.ts`;
  const virtualFile = path.join(path.dirname(sourcePath), virtualName);
  if (fs.existsSync(virtualFile)) {
    throw new Error(`Virtual test filename is occupied by an actual source file: ${virtualFile}`);
  }
  const originalCode = fs.readFileSync(testPath, 'utf8');
  const dist = path.join(output, 'dist');
  fs.mkdirSync(output, {recursive: true});

  const options = {
    ...parsed.options,
    outDir: dist,
    rootDir: path.join(backend, 'src'),
    noEmit: false,
    noEmitOnError: true,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    sourceMap: true,
    inlineSources: true
  };

  const isVirtual = file => path.resolve(file).toLowerCase() === virtualFile.toLowerCase();
  const host = ts.createCompilerHost(options);
  const oldFileExists = host.fileExists.bind(host);
  const oldReadFile = host.readFile.bind(host);
  const oldGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = file => isVirtual(file) || oldFileExists(file);
  host.readFile = file => isVirtual(file) ? originalCode : oldReadFile(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (isVirtual(file)) {
      return ts.createSourceFile(file, originalCode, languageVersion, true, ts.ScriptKind.TS);
    }
    return oldGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  };

  // Ignore all actual existing tests (including Trial 02), and type-check the
  // one virtual test file against the complete backend source dependencies.
  const isExistingTest = file => /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
  const sourceFiles = parsed.fileNames.filter(file => !isExistingTest(file));
  if (!sourceFiles.some(file => path.resolve(file).toLowerCase() === sourcePath.toLowerCase())) {
    throw new Error(`Target source missing from backend tsconfig: ${sourcePath}`);
  }
  const program = ts.createProgram([...sourceFiles, virtualFile], options, host);
  const errors = ts.getPreEmitDiagnostics(program);
  if (!errors.some(d => d.category === ts.DiagnosticCategory.Error)) {
    const emitted = program.emit();
    errors.push(...emitted.diagnostics);
  }

  const formatHost = {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => backend,
    getNewLine: () => '\n'
  };
  if (errors.length) {
    console.log(ts.formatDiagnosticsWithColorAndContext(errors, formatHost));
  }
  const failed = errors.some(d => d.category === ts.DiagnosticCategory.Error);
  const relativeTest = path.relative(path.join(backend, 'src'), virtualFile);
  const compiledJs = path.join(dist, relativeTest.replace(/\.[cm]?ts$/i, '.js'));
  if (!failed && !fs.existsSync(compiledJs)) {
    throw new Error(`Compilation reported success but output missing: ${compiledJs}`);
  }
  const outcome = {
    success: !failed,
    target,
    arm,
    source_file: sourceRelArg.replace(/\\/g, '/'),
    virtual_test_file: path.relative(backend, virtualFile).replace(/\\/g, '/'),
    archived_test_file: testPath,
    compiled_test_js: !failed ? compiledJs : null,
    typecheck_errors: errors.filter(d => d.category === ts.DiagnosticCategory.Error).length,
    typescript_version: ts.version,
    excluded_preexisting_test_files: parsed.fileNames.filter(isExistingTest).length,
    original_test_modified: false
  };
  fs.writeFileSync(path.join(output, 'compile_result.json'), JSON.stringify(outcome, null, 2) + '\n');
  console.log(`TypeScript ${ts.version} — ${arm}/${target}: ${failed ? 'COMPILE FAILED' : 'COMPILED'}`);
  if (!failed) console.log(`Compiled JS: ${compiledJs}`);
  if (failed) process.exitCode = 1;
}

try { main(); }
catch (error) { console.error(error.stack || String(error)); process.exitCode = 2; }
