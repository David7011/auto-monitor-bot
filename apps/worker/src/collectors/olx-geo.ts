import { getCityById } from "@amb/shared";
import { env } from "../env.js";
import type { SourceSearchContext } from "./base.js";
import { sourceHttpClient } from "./source-http-client.js";

export type OlxLocationScope = {
  regionId?: number;
  cityId?: number;
  htmlPath?: string;
};

type OlxGeoCity = {
  id: number;
  name: string;
  normalized_name?: string;
};

type OlxGeoCitiesResponse = {
  data?: OlxGeoCity[];
};

export type ResolvedOlxLocationScopes = {
  scopes: OlxLocationScope[];
  warnings: string[];
};

const OLX_FEED_REFERER = "https://www.olx.ua/uk/transport/legkovye-avtomobili/";
const OLX_REGION_IDS: Partial<Record<string, number>> = {
  sumska: 1,
  khersonska: 3,
  donetska: 4,
  lvivska: 5,
  zhytomyrska: 6,
  kirovohradska: 7,
  kharkivska: 8,
  odeska: 9,
  zakarpatska: 10,
  ternopilska: 11,
  cherkaska: 12,
  "ivano-frankivska": 13,
  rivnenska: 14,
  poltavska: 15,
  zaporizka: 17,
  chernivetska: 18,
  mykolaivska: 19,
  khmelnytska: 20,
  dnipropetrovska: 21,
  volynska: 22,
  chernihivska: 23,
  vinnytska: 24,
  kyivska: 25,
  "kyiv-city": 25,
};
const OLX_CITY_SCOPES: Partial<Record<string, OlxLocationScope>> = {
  dnipro: { regionId: 21, cityId: 121, htmlPath: "dnepr" },
  "katottg-ua12100070010038698": { regionId: 21, cityId: 316, htmlPath: "novomoskovsk" },
};
const OLX_REGION_PATHS: Partial<Record<string, string>> = {
  dnipropetrovska: "dnp",
};
const OLX_CITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const olxCitiesByRegionCache = new Map<number, { expiresAt: number; cities: OlxGeoCity[] }>();

export async function resolveOlxLocationScopes(context: SourceSearchContext): Promise<ResolvedOlxLocationScopes> {
  if (context.cities.length === 0) return { scopes: olxLocationScopes(context), warnings: [] };

  const scopes: OlxLocationScope[] = [];
  const warnings: string[] = [];
  for (const cityId of context.cities) {
    const configured = OLX_CITY_SCOPES[cityId];
    if (configured) {
      scopes.push(configured);
      continue;
    }

    const city = getCityById(cityId);
    const olxRegionId = city ? OLX_REGION_IDS[city.regionId] : undefined;
    if (!city || !olxRegionId) {
      scopes.push({});
      warnings.push(`OLX: город ${cityId} не сопоставлен, используется поиск по всей Украине`);
      continue;
    }

    const candidates = await fetchOlxCities(olxRegionId);
    const match = candidates.find((candidate) => matchesOlxCity(city, candidate));
    if (match) {
      scopes.push({ regionId: olxRegionId, cityId: match.id, htmlPath: match.normalized_name });
    } else {
      scopes.push({ regionId: olxRegionId, htmlPath: OLX_REGION_PATHS[city.regionId] });
      warnings.push(`OLX: для города ${city.nameRu} используется охват всей области, чтобы не пропустить объявления`);
    }
  }

  return { scopes: uniqueLocationScopes(scopes), warnings: [...new Set(warnings)] };
}

export function olxLocationScopes(context: SourceSearchContext): OlxLocationScope[] {
  if (context.cities.length > 0) {
    const cityScopes = context.cities
      .map((city) => OLX_CITY_SCOPES[city])
      .filter((scope): scope is OlxLocationScope => Boolean(scope));
    if (cityScopes.length === context.cities.length) return uniqueLocationScopes(cityScopes);
  }

  const regionScopes: OlxLocationScope[] = context.regions.flatMap((region) => {
    const regionId = OLX_REGION_IDS[region];
    return regionId ? [{ regionId, htmlPath: OLX_REGION_PATHS[region] }] : [];
  });
  return regionScopes.length > 0 ? uniqueLocationScopes(regionScopes) : [{}];
}

export function regionalCoverageScopes(context: SourceSearchContext): OlxLocationScope[] {
  return context.regions.flatMap((region) => {
    const regionId = OLX_REGION_IDS[region];
    return regionId ? [{ regionId, htmlPath: OLX_REGION_PATHS[region] }] : [];
  });
}

export function uniqueLocationScopes(scopes: OlxLocationScope[]): OlxLocationScope[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = `${scope.regionId ?? ""}:${scope.cityId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchOlxCities(regionId: number): Promise<OlxGeoCity[]> {
  const cached = olxCitiesByRegionCache.get(regionId);
  if (cached && cached.expiresAt > Date.now()) return cached.cities;

  const response = await sourceHttpClient.json<OlxGeoCitiesResponse>(
    `https://www.olx.ua/api/v1/geo-encoder/regions/${regionId}/cities`,
    {
      source: "OLX",
      timeoutMs: env.OLX_REQUEST_TIMEOUT_MS,
      headers: { referer: OLX_FEED_REFERER },
      requestClass: "REALTIME",
    },
  );
  const cities = response.classification === "SUCCESS" ? response.data?.data ?? [] : [];
  if (cities.length > 0) {
    olxCitiesByRegionCache.set(regionId, { expiresAt: Date.now() + OLX_CITY_CACHE_TTL_MS, cities });
  }
  return cities;
}

function matchesOlxCity(city: NonNullable<ReturnType<typeof getCityById>>, candidate: OlxGeoCity): boolean {
  const expected = new Set([city.nameUk, city.nameRu, ...city.aliases].map(normalizeGeoName));
  return expected.has(normalizeGeoName(candidate.name)) ||
    Boolean(candidate.normalized_name && expected.has(normalizeGeoName(candidate.normalized_name)));
}

function normalizeGeoName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[’'`]/gu, "")
    .replace(/[^a-zа-яіїєґ0-9]+/giu, "")
    .trim();
}
