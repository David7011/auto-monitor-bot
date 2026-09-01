import { closeDatabase } from "../src/index.js";

async function main(): Promise<void> {
  // Runtime state is created by migrations and the monitoring orchestrator.
}

main()
  .finally(async () => {
    await closeDatabase();
  })
  .catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
