import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const dashboardRoot = path.join(projectRoot, "apps", "dashboard");
const envPath = path.join(projectRoot, ".env");

if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, "").trim();
    }
    process.env[match[1]] = value;
  }
}

const requestedUrl = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3101");
const nextBin = path.join(dashboardRoot, "node_modules", "next", "dist", "bin", "next");
const isolatedEnv = {
  ...process.env,
  NEXT_DIST_DIR: ".next-e2e",
  NEXT_TSCONFIG_PATH: "tsconfig.e2e.json",
  NODE_ENV: "production",
};

const build = spawn(process.execPath, [nextBin, "build"], {
  cwd: dashboardRoot,
  env: isolatedEnv,
  stdio: "inherit",
});
const buildExitCode = await new Promise((resolve) => build.once("exit", (code) => resolve(code ?? 1)));
if (buildExitCode !== 0) process.exit(buildExitCode);

const child = spawn(process.execPath, [nextBin, "start", "-H", requestedUrl.hostname, "-p", requestedUrl.port || "3101"], {
  cwd: dashboardRoot,
  env: isolatedEnv,
  stdio: "inherit",
});

const stop = () => {
  if (!child.killed) child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
