import type { ListingSource } from "@amb/shared";
import type { SourceCollector } from "./base.js";
import { MockCollector } from "./mock.js";
import { AutoRiaCollector } from "./auto-ria.js";
import { OlxCollector } from "./olx.js";
import { RstCollector } from "./rst.js";
import { CarsUaCollector } from "./cars-ua.js";
import { AutoMotoCollector } from "./automoto.js";
import { env } from "../env.js";

const collectors = new Map<ListingSource, SourceCollector>();

collectors.set("MOCK", new MockCollector());
collectors.set("OLX", new OlxCollector());
collectors.set("RST", new RstCollector());
collectors.set("CARS_UA", new CarsUaCollector());
collectors.set("AUTOMOTO", new AutoMotoCollector());

// AUTO.RIA is only registered when an API key is available;
// otherwise the MOCK source is used for testing the pipeline.
if (env.AUTO_RIA_API_KEY) {
  collectors.set("AUTO_RIA", new AutoRiaCollector());
}

export function getCollector(source: ListingSource): SourceCollector | undefined {
  return collectors.get(source);
}
