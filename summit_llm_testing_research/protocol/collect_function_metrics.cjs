/**
 * Summit LLM Unit Test Research — Step 3: service-function metrics.
 *
 * Place this file in: <research-root>/protocol/collect_function_metrics.cjs
 * Run from research root: node .\protocol\collect_function_metrics.cjs
 *
 * Reads source only. Does not alter application code or call an LLM.
 * Uses the TypeScript compiler already installed in summit/app/server.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const server = path.join(root, 'summit', 'app', 'server');
const requireFromServer = createRequire(path.join(server, 'package.json'));
let ts;
try {
  ts = requireFromServer('typescript');
} catch (error) {
  throw new Error('TypeScript not installed in summit/app/server. Run npm install there first.', { cause: error });
}

const targets = {
  auth: 'auth/auth.services.ts',
  comments: 'comments/comments.services.ts',
  communities: 'communities/communities.services.ts',
  posts: 'posts/posts.service.ts',
};

const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const isExported = node => (node.modifiers || []).some(
  modifier => modifier.kind === ts.SyntaxKind.ExportKeyword
);
const line = (source, position) => source.getLineAndCharacterOfPosition(position).line + 1;

function metricsForFunction(node, source, sourceText, feature, relativeFile, fileHash) {
  const counts = {
    if_statements: 0,
    ternary_expressions: 0,
    switch_cases: 0,
    loops: 0,
    catch_clauses: 0,
    logical_operators: 0,
    call_expressions: 0,
    await_expressions: 0,
    throw_statements: 0,
    return_statements: 0,
  };

  function visit(current) {
    if (ts.isIfStatement(current)) counts.if_statements++;
    if (ts.isConditionalExpression(current)) counts.ternary_expressions++;
    if (ts.isCaseClause(current)) counts.switch_cases++;
    if (
      ts.isForStatement(current) || ts.isForOfStatement(current) ||
      ts.isForInStatement(current) || ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) counts.loops++;
    if (ts.isCatchClause(current)) counts.catch_clauses++;
    if (
      ts.isBinaryExpression(current) && [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    ) counts.logical_operators++;
    if (ts.isCallExpression(current)) counts.call_expressions++;
    if (ts.isAwaitExpression(current)) counts.await_expressions++;
    if (ts.isThrowStatement(current)) counts.throw_statements++;
    if (ts.isReturnStatement(current)) counts.return_statements++;
    ts.forEachChild(current, visit);
  }
  if (node.body) visit(node.body);

  const start = node.getStart(source);
  const end = node.getEnd();
  const functionText = sourceText.slice(start, end);
  const decisionPoints = counts.if_statements + counts.ternary_expressions +
    counts.switch_cases + counts.loops + counts.catch_clauses +
    counts.logical_operators;

  return {
    feature,
    function: node.name.text,
    source_file: relativeFile,
    start_line: line(source, start),
    end_line: line(source, Math.max(start, end - 1)),
    physical_lines: line(source, Math.max(start, end - 1)) - line(source, start) + 1,
    nonblank_lines: functionText.split(/\r?\n/).filter(x => x.trim() !== '').length,
    parameter_count: node.parameters.length,
    ...counts,
    decision_points: decisionPoints,
    complexity_proxy: 1 + decisionPoints,
    file_sha256: fileHash,
    function_sha256: hash(functionText),
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return '"' + text.replace(/"/g, '""') + '"';
}

const results = [];
for (const [feature, relative] of Object.entries(targets)) {
  const filename = path.join(server, 'src', relative);
  if (!fs.existsSync(filename)) throw new Error(`Missing service file: ${filename}`);
  const content = fs.readFileSync(filename, 'utf8');
  const parsed = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (parsed.parseDiagnostics.length) {
    throw new Error(`TypeScript parse error in ${filename}: ${parsed.parseDiagnostics[0].messageText}`);
  }
  const fileHash = hash(content);
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      results.push(metricsForFunction(
        statement, parsed, content, feature, `src/${relative}`, fileHash
      ));
    }
  }
}

results.sort((a, b) => a.feature.localeCompare(b.feature) || a.start_line - b.start_line);
const outDir = path.join(root, 'protocol');
fs.mkdirSync(outDir, { recursive: true });
if (!results.length) throw new Error('No exported service functions found.');
const header = Object.keys(results[0]);
const csv = [header.map(csvCell).join(','), ...results.map(
  row => header.map(key => csvCell(row[key])).join(',')
)].join('\r\n') + '\r\n';
fs.writeFileSync(path.join(outDir, 'function_metrics.csv'), csv, 'utf8');
fs.writeFileSync(path.join(outDir, 'function_metrics.json'), JSON.stringify({
  measurement: 'TypeScript AST-based static count (not measured test coverage)',
  complexity_note: 'Complexity proxy = 1 + syntactic decision points, including nested callbacks.',
  functions: results,
}, null, 2) + '\n', 'utf8');

console.log(`\nSaved ${results.length} exported service functions.`);
console.log('Feature counts:');
for (const feature of Object.keys(targets)) {
  console.log(`  ${feature.padEnd(12)} ${results.filter(row => row.feature === feature).length}`);
}
console.log('\nFeature / function                 Lines  Decisions  Complexity proxy  Calls');
for (const row of results) {
  console.log(`${(row.feature + '/' + row.function).padEnd(36)} ${String(row.physical_lines).padStart(5)} ${String(row.decision_points).padStart(10)} ${String(row.complexity_proxy).padStart(17)} ${String(row.call_expressions).padStart(6)}`);
}
if (results.length !== 27) console.warn(`\nNote: found ${results.length} functions; previous inventory had 27. Check why they differ.`);
console.log('\nResults: protocol/function_metrics.csv and protocol/function_metrics.json');
