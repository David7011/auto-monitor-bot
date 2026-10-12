import { prisma } from "@amb/db";
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(process.cwd(), "..", "..", ".env") });

const windows = await prisma.coverageRecoveryWindow.findMany({
  where: { status: "UNRESOLVED" },
  select: { id: true, status: true, unresolvedReason: true, requiredCutoffAt: true, createdAt: true },
  orderBy: { createdAt: "desc" },
  take: 10,
});
console.log(JSON.stringify(windows, null, 1));

const token = process.env.LOCAL_API_TOKEN ?? "";
const api = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";
for (const w of windows) {
  const res = await fetch(`${api}/search-plan/recovery/${w.id}/retry`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  console.log(`RETRY ${w.id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}
await prisma.$disconnect();
