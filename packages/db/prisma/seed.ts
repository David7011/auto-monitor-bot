import { prisma } from "../src/index.js";

async function main(): Promise<void> {
  // Runtime state is created by migrations and the monitoring orchestrator.
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
