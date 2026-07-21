import { QUEUE_NAMES } from "@amb/shared";
import { runVehicleCheck } from "../modules/vehicle-check.js";
import { enqueue } from "../lib/queues.js";

export type VehicleCheckJob = { listingId: string };

/**
 * vehicle.check — runs the (fake, for MVP) vehicle check and then queues
 * telegram.update so the already-sent message gets edited with the result.
 */
export async function processVehicleCheck(job: VehicleCheckJob): Promise<void> {
  await runVehicleCheck(job.listingId);
  await enqueue(QUEUE_NAMES.TELEGRAM_UPDATE, "update", { listingId: job.listingId });
}
