import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cryptoScript = fileURLToPath(new URL("./backup-crypto.mjs", import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), "amb-backup-crypto-"));
const inputPath = join(testRoot, "database.dump");
const archivePath = join(testRoot, "database.ambbak");
const restoredPath = join(testRoot, "restored.dump");
const rejectedPath = join(testRoot, "rejected.dump");
const password = "test-only-password-with-more-than-32-characters";

function run(operation, input, output, suppliedPassword = password) {
  const args = [cryptoScript, operation, input, output];
  assert.equal(args.some((argument) => argument.includes(suppliedPassword)), false);
  return spawnSync(process.execPath, args, {
    input: Buffer.from(`${suppliedPassword}\n`, "utf8"),
    encoding: "utf8",
    windowsHide: true,
  });
}

try {
  const original = Buffer.concat([
    Buffer.from("PostgreSQL custom dump test\0", "utf8"),
    Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251)),
  ]);
  writeFileSync(inputPath, original);

  const encrypted = run("encrypt", inputPath, archivePath);
  assert.equal(encrypted.status, 0, encrypted.stderr);
  assert.notDeepEqual(readFileSync(archivePath).subarray(0, original.length), original);

  const decrypted = run("decrypt", archivePath, restoredPath);
  assert.equal(decrypted.status, 0, decrypted.stderr);
  assert.deepEqual(readFileSync(restoredPath), original);

  const wrongPassword = run(
    "decrypt",
    archivePath,
    rejectedPath,
    "different-test-password-with-more-than-32-characters",
  );
  assert.notEqual(wrongPassword.status, 0);
  assert.throws(() => readFileSync(rejectedPath));

  const tampered = readFileSync(archivePath);
  tampered[Math.floor(tampered.length / 2)] ^= 1;
  writeFileSync(archivePath, tampered);
  const rejectedTamper = run("decrypt", archivePath, rejectedPath);
  assert.notEqual(rejectedTamper.status, 0);
  assert.throws(() => readFileSync(rejectedPath));

  console.log("Backup crypto round-trip, wrong-password, and tamper tests passed");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
