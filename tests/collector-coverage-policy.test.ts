import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCollectorCoveragePolicy } from '../scripts/collector-coverage-policy.mjs';

const source = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
describe('collector coverage CI policy', () => {
  it('accepts the actual immutable minimum gate', () => expect(() => validateCollectorCoveragePolicy(source)).not.toThrow());
  it.each(['statements', 'branches', 'functions', 'lines'])('rejects lowering %s', (name) => {
    const altered = source.replace(/("apps\/worker\/src\/processors\/collector-run\.ts":\s*\{)([^}]+)/,
      (_, prefix, body: string) => prefix + body.replace(new RegExp(`${name}: \\d+`), `${name}: 79`));
    expect(() => validateCollectorCoveragePolicy(altered)).toThrow();
  });
  it('rejects removed or renamed gate', () => {
    expect(() => validateCollectorCoveragePolicy(source.replace('processors/collector-run.ts', 'processors/other.ts'))).toThrow();
    expect(() => validateCollectorCoveragePolicy(source.replace(/"apps\/worker\/src\/processors\/collector-run\.ts":\s*\{[^}]+\},/, ''))).toThrow();
  });
  it('rejects a collector excluded from calculation', () => {
    expect(() => validateCollectorCoveragePolicy(source.replace('exclude: [', 'exclude: ["**/collector-run.ts",'))).toThrow();
    expect(() => validateCollectorCoveragePolicy(source.replace('"apps/worker/src/**/*.ts",', ''))).toThrow();
  });
  it('ignores comments as policy evidence', () => {
    expect(() => validateCollectorCoveragePolicy('// ' + source.replace(/\n/g, '\n// '))).toThrow();
  });
});
