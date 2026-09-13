import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const script = readFileSync(new URL("../scripts/check.ps1", import.meta.url), "utf8");
describe("validation profile safeguards", () => {
  it("keeps fast validation separate from the CI release gate", () => {
    expect(script).toContain('if ($Ci -and $Fast) { throw');
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toContain("pnpm check:ci");
    expect(workflow).not.toContain("check:fast");
  });
  it("runs all unit tests in fast mode and retains full coverage/build checks", () => {
    expect(script).toMatch(/if \(\$Fast\)\s*\{[\s\S]*?@\("test"\)[\s\S]*?return/);
    expect(script).toContain('@("test:coverage")');
    expect(script).toContain('verify-production-build.ps1');
    expect(script).toContain('amb.cmd');
  });
});
