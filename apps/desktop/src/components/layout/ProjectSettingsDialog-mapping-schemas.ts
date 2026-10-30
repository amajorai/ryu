import { z } from "zod";

const projectRootMappingResponseSchema = z
	.object({
		organizationId: z.string(),
		projectId: z.string(),
		root: z.string(),
	})
	.passthrough();

export const projectRootMappingsResponseSchema = z
	.object({ mappings: z.array(projectRootMappingResponseSchema) })
	.passthrough();
