import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

assert.equal(packageJson.packageManager, "pnpm@10.34.5", "packageManager must remain pinned");
assert.match(workflow, /node-version:\s*24\.18\.0/g);
assert.equal((workflow.match(/node-version:\s*24\.18\.0/g) ?? []).length, 4);
assert.doesNotMatch(workflow, /version:\s*10\.0\.0/);
assert.match(workflow, /run:\s*pnpm check:ci/);
assert.match(workflow, /image:\s*postgres:18\.6(?:\s|$)/m);
assert.match(workflow, /image:\s*postgres:18\.6-alpine(?:\s|$)/m);
assert.match(workflow, /image:\s*redis:8\.8\.0-alpine(?:\s|$)/m);
assert.doesNotMatch(workflow, /android|gradle|mobile-android|\.apk|\.aab/i);

const externalActions = [...workflow.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
assert.ok(externalActions.length > 0, "CI workflow must contain external actions");
for (const action of externalActions) {
  assert.match(action, /^[^@]+@[0-9a-f]{40}$/, `Action must be pinned to a full commit SHA: ${action}`);
}

assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
assert.match(workflow, /^concurrency:/m);
assert.equal(projectRoot.endsWith("auto-monitor-bot\\") || projectRoot.endsWith("auto-monitor-bot/"), true);

console.log("CI policy validation passed: desktop-only, pinned runtime/services, SHA-pinned actions");
