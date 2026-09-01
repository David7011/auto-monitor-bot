import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "@amb/db";
import {
  analyzeFilterHygiene,
  findExactActiveFilter,
  normalizeCityIds,
  normalizeRegionIds,
  QUEUE_NAMES,
  type FilterHygieneCandidate,
} from "@amb/shared";
import { enqueue } from "../lib/queues.js";
import { compactFilterSearchStates } from "../modules/filter-state-hygiene.js";

const sourceEnum = z.enum(["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO", "MOCK"]);
const freshnessModeEnum = z.enum(["LAST_HOUR", "TODAY", "LAST_24_HOURS", "LAST_3_DAYS", "LAST_7_DAYS", "ALL_TIME"]);
const nullableText = z
  .string()
  .trim()
  .transform((value) => (value.length > 0 ? value : null))
  .nullable()
  .optional();

const filterShape = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  sources: z.array(sourceEnum).default([]),
  autoRiaCategoryId: z.number().int().min(1).nullable().optional(),
  autoRiaMarkId: z.number().int().min(1).nullable().optional(),
  autoRiaModelId: z.number().int().min(1).nullable().optional(),
  brand: nullableText,
  model: nullableText,
  modelNames: z.array(z.string().trim().min(1)).default([]),
  generation: nullableText,
  bodyTypes: z.array(z.string()).default([]),
  fuelTypes: z.array(z.string()).default([]),
  gearboxes: z.array(z.string()).default([]),
  driveTypes: z.array(z.string()).default([]),
  colors: z.array(z.string().trim().min(1)).default([]),
  engineVolumeFrom: z.number().min(0).nullable().optional(),
  engineVolumeTo: z.number().min(0).nullable().optional(),
  enginePowerFrom: z.number().int().min(0).nullable().optional(),
  enginePowerTo: z.number().int().min(0).nullable().optional(),
  doorsFrom: z.number().int().min(0).max(10).nullable().optional(),
  doorsTo: z.number().int().min(0).max(10).nullable().optional(),
  seatsFrom: z.number().int().min(0).max(80).nullable().optional(),
  seatsTo: z.number().int().min(0).max(80).nullable().optional(),
  conditions: z.array(z.string().trim().min(1)).default([]),
  customsCleared: z.boolean().nullable().optional(),
  bargainPossible: z.boolean().nullable().optional(),
  freshnessMode: freshnessModeEnum.default("TODAY"),
  yearFrom: z.number().int().min(1950).max(2100).nullable().optional(),
  yearTo: z.number().int().min(1950).max(2100).nullable().optional(),
  priceFrom: z.number().int().min(0).nullable().optional(),
  priceTo: z.number().int().min(0).nullable().optional(),
  mileageFrom: z.number().int().min(0).nullable().optional(),
  mileageTo: z.number().int().min(0).nullable().optional(),
  regions: z.array(z.string()).default([]),
  cities: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
});

function validateRange(
  ctx: z.RefinementCtx,
  from: number | null | undefined,
  to: number | null | undefined,
  fromPath: string,
  toPath: string,
) {
  if (from == null || to == null || from <= to) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${fromPath} must be less than or equal to ${toPath}`,
    path: [fromPath],
  });
}

function validateFilterRanges(data: Partial<z.infer<typeof filterShape>>, ctx: z.RefinementCtx) {
  validateRange(ctx, data.yearFrom, data.yearTo, "yearFrom", "yearTo");
  validateRange(ctx, data.priceFrom, data.priceTo, "priceFrom", "priceTo");
  validateRange(ctx, data.mileageFrom, data.mileageTo, "mileageFrom", "mileageTo");
  validateRange(ctx, data.engineVolumeFrom, data.engineVolumeTo, "engineVolumeFrom", "engineVolumeTo");
  validateRange(ctx, data.enginePowerFrom, data.enginePowerTo, "enginePowerFrom", "enginePowerTo");
  validateRange(ctx, data.doorsFrom, data.doorsTo, "doorsFrom", "doorsTo");
  validateRange(ctx, data.seatsFrom, data.seatsTo, "seatsFrom", "seatsTo");
}

const filterInputSchema = filterShape.superRefine(validateFilterRanges);
const filterPatchSchema = filterShape.partial().superRefine(validateFilterRanges);

function normalizeFilterGeo<T extends { regions?: string[]; cities?: string[] }>(data: T): T {
  const regions = data.regions ? normalizeRegionIds(data.regions) : undefined;
  const cities = data.cities ? normalizeCityIds(data.cities, regions ?? []) : undefined;
  return {
    ...data,
    ...(regions ? { regions } : {}),
    ...(cities ? { cities } : {}),
  };
}

export async function filtersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/filters", async () => {
    const filters = await prisma.filter.findMany({ orderBy: { createdAt: "desc" } });
    return { filters, hygiene: { warnings: analyzeFilterHygiene(filters) } };
  });

  app.post("/filters", async (req, reply) => {
    const parsed = filterInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const data = normalizeFilterGeo(parsed.data);
    const createData = {
      ...data,
      autoRiaCategoryId: data.autoRiaCategoryId ?? null,
      autoRiaMarkId: data.autoRiaMarkId ?? null,
      autoRiaModelId: data.autoRiaModelId ?? null,
      brand: data.brand ?? null,
      model: data.model ?? null,
      generation: data.generation ?? null,
      engineVolumeFrom: data.engineVolumeFrom ?? null,
      engineVolumeTo: data.engineVolumeTo ?? null,
      enginePowerFrom: data.enginePowerFrom ?? null,
      enginePowerTo: data.enginePowerTo ?? null,
      doorsFrom: data.doorsFrom ?? null,
      doorsTo: data.doorsTo ?? null,
      seatsFrom: data.seatsFrom ?? null,
      seatsTo: data.seatsTo ?? null,
      customsCleared: data.customsCleared ?? null,
      bargainPossible: data.bargainPossible ?? null,
      yearFrom: data.yearFrom ?? null,
      yearTo: data.yearTo ?? null,
      priceFrom: data.priceFrom ?? null,
      priceTo: data.priceTo ?? null,
      mileageFrom: data.mileageFrom ?? null,
      mileageTo: data.mileageTo ?? null,
    };
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('auto-monitor-bot:filter-mutation'))`;
      const activeFilters = await tx.filter.findMany({ where: { enabled: true } });
      const duplicate = findExactActiveFilter(
        { id: "__new_filter__", ...createData } as FilterHygieneCandidate,
        activeFilters,
      );
      if (duplicate) return { duplicate, filter: null };
      const filter = await tx.filter.create({ data: createData });
      return { duplicate: null, filter };
    });
    if (result.duplicate) return exactDuplicateReply(reply, result.duplicate);

    const filter = result.filter;
    if (!filter) return reply.code(500).send({ error: "Filter was not created" });
    await compactAfterFilterMutation(app);
    await enqueueFilterReplay(app, "FILTER_CHANGED");
    const activeFilters = await prisma.filter.findMany({ where: { enabled: true } });
    return reply.code(201).send({ filter, hygiene: { warnings: analyzeFilterHygiene(activeFilters) } });
  });

  app.patch<{ Params: { id: string } }>("/filters/:id", async (req, reply) => {
    const parsed = filterPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const data = normalizeFilterGeo(parsed.data);
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('auto-monitor-bot:filter-mutation'))`;
      const existing = await tx.filter.findUnique({ where: { id: req.params.id } });
      if (!existing) return { notFound: true as const, duplicate: null, filter: null };

      const nextRegions = data.regions ?? existing.regions;
      const nextCities = data.cities ?? (data.regions ? normalizeCityIds(existing.cities, nextRegions) : existing.cities);
      const updateData = {
        ...data,
        ...(data.regions ? { regions: nextRegions, cities: nextCities } : {}),
      };
      const nextFilter = { ...existing, ...updateData };
      const activeFilters = await tx.filter.findMany({ where: { enabled: true } });
      const currentDuplicate = existing.enabled
        ? findExactActiveFilter(existing, activeFilters, existing.id)
        : undefined;
      const nextDuplicate = nextFilter.enabled
        ? findExactActiveFilter(nextFilter, activeFilters, existing.id)
        : undefined;
      if (nextDuplicate && nextDuplicate.id !== currentDuplicate?.id) {
        return { notFound: false as const, duplicate: nextDuplicate, filter: null };
      }

      const filter = await tx.filter.update({ where: { id: req.params.id }, data: updateData });
      return { notFound: false as const, duplicate: null, filter };
    });
    if (result.notFound) return reply.code(404).send({ error: "Filter not found" });
    if (result.duplicate) return exactDuplicateReply(reply, result.duplicate);

    const filter = result.filter;
    if (!filter) return reply.code(500).send({ error: "Filter was not updated" });
    await compactAfterFilterMutation(app);
    await enqueueFilterReplay(app, "FILTER_CHANGED");
    const activeFilters = await prisma.filter.findMany({ where: { enabled: true } });
    return { filter, hygiene: { warnings: analyzeFilterHygiene(activeFilters) } };
  });

  app.delete<{ Params: { id: string } }>("/filters/:id", async (req, reply) => {
    const existing = await prisma.filter.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: "Filter not found" });

    await prisma.filter.delete({ where: { id: req.params.id } });
    await compactAfterFilterMutation(app);
    await enqueueFilterReplay(app, "FILTER_CHANGED");
    return { ok: true };
  });
}

function exactDuplicateReply(reply: FastifyReply, duplicate: FilterHygieneCandidate) {
  return reply.code(409).send({
    code: "EXACT_FILTER_DUPLICATE",
    error: `Такой активный фильтр уже существует: «${duplicate.name}». Откройте его или измените условия нового фильтра.`,
    existingFilterId: duplicate.id,
    existingFilterName: duplicate.name,
  });
}

async function compactAfterFilterMutation(app: FastifyInstance): Promise<void> {
  try {
    await compactFilterSearchStates();
  } catch (error) {
    app.log.warn({ err: error }, "Filter saved, but obsolete source search states could not be compacted immediately");
  }
}

async function enqueueFilterReplay(app: FastifyInstance, trigger: "FILTER_CHANGED"): Promise<void> {
  try {
    await enqueue(
      QUEUE_NAMES.OBSERVATION_REPLAY,
      "replay",
      { trigger, lookbackHours: 48, limit: 1_000 },
      { jobId: `filter-replay-${Date.now()}` },
    );
  } catch (error) {
    app.log.warn({ err: error }, "Filter saved, but immediate observation replay could not be queued");
  }
}
