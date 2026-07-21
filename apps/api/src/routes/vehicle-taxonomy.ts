import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMarks, getModels, ukrainianRegions, vehicleAttributeGroups } from "../modules/vehicle-taxonomy.js";

const marksQuerySchema = z.object({
  categoryId: z.coerce.number().int().min(1).default(1),
});

const modelsQuerySchema = z.object({
  categoryId: z.coerce.number().int().min(1).default(1),
  markId: z.coerce.number().int().min(1),
});

export async function vehicleTaxonomyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/vehicle-taxonomy/options", async () => ({ groups: vehicleAttributeGroups() }));
  app.get("/vehicle-taxonomy/regions", async () => ukrainianRegions());

  app.get("/vehicle-taxonomy/marks", async (req, reply) => {
    const parsed = marksQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const result = await getMarks(parsed.data.categoryId);
    return { ...result, categoryId: parsed.data.categoryId };
  });

  app.get("/vehicle-taxonomy/models", async (req, reply) => {
    const parsed = modelsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const result = await getModels(parsed.data.categoryId, parsed.data.markId);
    return { ...result, categoryId: parsed.data.categoryId, markId: parsed.data.markId };
  });
}
