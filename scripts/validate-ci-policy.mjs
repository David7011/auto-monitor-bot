import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCollectorCoveragePolicy } from "./collector-coverage-policy.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
validateCollectorCoveragePolicy(readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8'));

assert.equal(packageJson.packageManager, "pnpm@10.34.5", "packageManager must remain pinned");
assert.match(workflow, /node-version:\s*24\.18\.0/g);
assert.equal((workflow.match(/node-version:\s*24\.18\.0/g) ?? []).length, 4);
assert.doesNotMatch(workflow, /version:\s*10\.0\.0/);
assert.match(workflow, /run:\s*pnpm check:ci/);
assert.equal(
  (workflow.match(/run:\s*pnpm db:generate/g) ?? []).length,
  2,
  "Every clean Linux build job must generate the Prisma client before build:deploy",
);
assert.match(workflow, /image:\s*postgres:18\.6(?:\s|$)/m);
assert.match(workflow, /image:\s*postgres:18\.6-alpine(?:\s|$)/m);
assert.match(workflow, /image:\s*redis:8\.8\.0-alpine(?:\s|$)/m);
assert.doesNotMatch(workflow, /android|gradle|mobile-android|\.apk|\.aab/i);
assert.match(workflow, /run:\s*pnpm exec playwright install chromium/);
assert.match(
  workflow,
  /PLAYWRIGHT_BROWSERS_PATH:\s*\$\{\{ github\.workspace \}\}\/\.runtime\/playwright-browsers/,
  "Playwright install and test must share the repository-local browser path",
);
assert.doesNotMatch(
  workflow,
  /playwright install --with-deps/,
  "Dashboard E2E must not depend on refreshing unrelated runner APT repositories",
);

const externalActions = [...workflow.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
assert.ok(externalActions.length > 0, "CI workflow must contain external actions");
const approvedActionPins = new Map([
  ["actions/checkout", "11bd71901bbe5b1630ceea73d27597364c9af683"],
  ["pnpm/action-setup", "f40ffcd9367d9f12939873eb1018b921a783ffaa"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["github/codeql-action/init", "ddf5ce7296213f5548c91e2dd19df2d77d2b2d66"],
  ["github/codeql-action/analyze", "ddf5ce7296213f5548c91e2dd19df2d77d2b2d66"],
]);
for (const action of externalActions) {
  assert.match(action, /^[^@]+@[0-9a-f]{40}$/, `Action must be pinned to a full commit SHA: ${action}`);
  const [name, revision] = action.split("@");
  assert.equal(
    revision,
    approvedActionPins.get(name),
    `Action pin is not the reviewed revision for ${name}`,
  );
}

assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
assert.match(workflow, /^concurrency:/m);
assert.equal(projectRoot.endsWith("auto-monitor-bot\\") || projectRoot.endsWith("auto-monitor-bot/"), true);

console.log("CI policy validation passed: desktop-only, pinned runtime/services, SHA-pinned actions");
