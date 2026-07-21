import { prisma } from "@amb/db";
import { runRetentionMaintenance } from "../modules/retention.js";

try {
  await runRetentionMaintenance();
  console.log("Retention maintenance completed successfully.");
} finally {
  await prisma.$disconnect();
}
