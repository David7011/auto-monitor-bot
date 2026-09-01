import { closeDatabase } from "@amb/db";
import {
  adoptFreshListingNotifications,
  previewListingRetention,
  runListingRetentionMaintenance,
} from "../modules/listing-retention.js";

const apply = process.argv.includes("--apply");
const maxBatches = 100;

try {
  const before = await previewListingRetention();
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", before }, null, 2));
  if (!apply) process.exitCode = before.due > 0 ? 2 : 0;

  if (apply) {
    const adoption = await adoptFreshListingNotifications();
    console.log(JSON.stringify({ adoption }, null, 2));
    const totals = {
      batches: 0,
      selected: 0,
      deletedListings: 0,
      detachedObservations: 0,
      telegramCleared: 0,
      legacyLocalOnly: 0,
      deferred: 0,
      skipped: 0,
    };
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await runListingRetentionMaintenance();
      totals.batches += 1;
      totals.selected += result.selected;
      totals.deletedListings += result.deletedListings;
      totals.detachedObservations += result.detachedObservations;
      totals.telegramCleared += result.telegramCleared;
      totals.legacyLocalOnly += result.legacyLocalOnly;
      totals.deferred += result.deferred;
      totals.skipped += result.skipped;
      if (result.selected === 0 || result.deletedListings + result.deferred + result.skipped === 0) break;
    }
    const after = await previewListingRetention();
    console.log(JSON.stringify({ totals, after }, null, 2));
  }
} finally {
  await closeDatabase();
}
