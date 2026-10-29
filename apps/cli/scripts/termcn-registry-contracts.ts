import { z } from "zod";

const registryFileSchema = z.object({
	content: z.string(),
	path: z.string(),
	target: z.string().optional(),
});

/** The public termcn registry item fields consumed by the vendor importer. */
export const termcnRegistryItemSchema = z.object({
	dependencies: z.array(z.string()).optional(),
	files: z.array(registryFileSchema).optional(),
	name: z.string(),
	registryDependencies: z.array(z.string()).optional(),
});
export type TermcnRegistryFile = z.infer<typeof registryFileSchema>;
