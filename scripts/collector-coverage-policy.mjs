import assert from 'node:assert/strict';
import ts from 'typescript';

export const COLLECTOR_COVERAGE_PATH = 'apps/worker/src/processors/collector-run.ts';

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
  const gate = property(property(coverage, 'thresholds'), COLLECTOR_COVERAGE_PATH);
  for (const [name, minimum] of Object.entries({ statements: 80, branches: 80, functions: 85, lines: 80 })) {
    const value = property(gate, name);
    assert.ok(ts.isNumericLiteral(value) && Number(value.text) >= minimum,
      `collector-run.ts ${name} threshold must be >= ${minimum}`);
  }
  assert.ok(strings(property(coverage, 'include')).some((pattern) => matches(pattern, COLLECTOR_COVERAGE_PATH)),
    'Coverage include must cover collector-run.ts');
  assert.ok(!strings(property(coverage, 'exclude')).some((pattern) => matches(pattern, COLLECTOR_COVERAGE_PATH)),
    'Coverage exclude must not remove collector-run.ts');
}
