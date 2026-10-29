import { z } from "zod";

/** Fields consumed from Core's sidecar catalog; extra server metadata is retained. */
export const sidecarCatalogItemSchema = z.looseObject({
	category: z.string().optional(),
	description: z.string().optional(),
	install_state: z.string().optional(),
	installed_version: z.string().nullable().optional(),
	latest_version: z.string().nullable().optional(),
	name: z.string().optional(),
	recommended: z.boolean().optional(),
});

export const sidecarCatalogSchema = z.looseObject({
	sidecars: z.array(sidecarCatalogItemSchema).optional(),
});
