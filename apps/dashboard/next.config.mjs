import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync } from "node:fs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadRootEnv()

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@amb/shared"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }]
  },
}

export default nextConfig

function loadRootEnv() {
  const envPath = path.join(__dirname, "../..", ".env")
  if (!existsSync(envPath)) return

  const text = readFileSync(envPath, "utf8")
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue
    const [key, ...rest] = trimmed.split("=")
    const name = key.trim()
    if (!name || process.env[name] != null) continue
    process.env[name] = rest.join("=").trim().replace(/^["']|["']$/gu, "")
  }
}
