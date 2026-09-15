import assert from 'node:assert/strict';
import ts from 'typescript';

export const COLLECTOR_COVERAGE_PATH = 'apps/worker/src/processors/collector-run.ts';
export const CRITICAL_COVERAGE_GATES = Object.freeze({
  [COLLECTOR_COVERAGE_PATH]: Object.freeze({ statements: 80, branches: 80, functions: 85, lines: 80 }),
  'apps/worker/src/modules/delivery-outbox.ts': Object.freeze({ statements: 90, branches: 90, functions: 90, lines: 90 }),
  'apps/worker/src/modules/listing-retention.ts': Object.freeze({ statements: 90, branches: 90, functions: 90, lines: 90 }),
});

function property(object, name) {
  assert.ok(object && ts.isObjectLiteralExpression(object), `Static object required for ${name}`);
  const matches = object.properties.filter((item) => ts.isPropertyAssignment(item)
    && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
  assert.equal(matches.length, 1, `Exactly one ${name} property is required`);
  assert.ok(!object.properties.some((item) => ts.isSpreadAssignment(item)), 'Coverage policy cannot verify object spreads');
  return matches[0].initializer;
}

function strings(node) {
  assert.ok(ts.isArrayLiteralExpression(node), 'Coverage include/exclude must be static arrays');
  return node.elements.map((item) => {
    assert.ok(ts.isStringLiteral(item), 'Coverage patterns must be literal strings');
    return item.text;
  });
}

function matches(pattern, path) {
  // Only the repository's explicit glob subset is accepted, fail closed for
  // extglobs/braces rather than guessing Vitest matching semantics.
  assert.ok(!/[{}()[\]!]/.test(pattern), 'Unsupported coverage glob');
  const escaped = pattern.replace(/[.+^$|\\]/g, '\\$&');
  assert.ok(!pattern.includes('__AMB_GLOB_'), 'Unsupported coverage glob placeholder');
  const regex = escaped.replace(/\*\*\//g, '__AMB_GLOB_DIR__').replace(/\*\*/g, '__AMB_GLOB_ALL__')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replaceAll('__AMB_GLOB_DIR__', '(?:.*/)?').replaceAll('__AMB_GLOB_ALL__', '.*');
  return new RegExp(`^${regex}$`).test(path);
}

export function validateCollectorCoveragePolicy(source) {
  const file = ts.createSourceFile('vitest.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const defaults = file.statements.filter((item) => ts.isExportAssignment(item));
  assert.equal(defaults.length, 1, 'One default Vitest config is required');
  const expression = defaults[0].expression;
  assert.ok(ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'defineConfig' && expression.arguments.length === 1,
  'Static defineConfig object required');
  const coverage = property(property(expression.arguments[0], 'test'), 'coverage');
  const thresholds = property(coverage, 'thresholds');
  const include = strings(property(coverage, 'include'));
  const exclude = strings(property(coverage, 'exclude'));
  for (const [path, minimums] of Object.entries(CRITICAL_COVERAGE_GATES)) {
    const gate = property(thresholds, path);
    for (const [name, minimum] of Object.entries(minimums)) {
      const value = property(gate, name);
      assert.ok(ts.isNumericLiteral(value) && Number(value.text) >= minimum,
        `${path} ${name} threshold must be >= ${minimum}`);
    }
    assert.ok(include.some((pattern) => matches(pattern, path)),
      `Coverage include must cover ${path}`);
    assert.ok(!exclude.some((pattern) => matches(pattern, path)),
      `Coverage exclude must not remove ${path}`);
  }
}
