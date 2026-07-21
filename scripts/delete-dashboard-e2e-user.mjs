import { prisma } from "../packages/db/dist/index.js";

const username = process.argv[2] ?? "";
if (!/^e2e-[a-f0-9]{32}$/u.test(username)) {
  console.error("Refusing to delete a dashboard user without the temporary E2E prefix");
  process.exit(1);
}

try {
  const result = await prisma.dashboardUser.deleteMany({ where: { username } });
  console.log(JSON.stringify({ ok: true, deleted: result.count }));
} finally {
  await prisma.$disconnect();
}
