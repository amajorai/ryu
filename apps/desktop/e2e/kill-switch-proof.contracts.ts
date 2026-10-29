import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

const menuItem = z.object({
	id: z.string(),
	label: z.string(),
	icon: z.string(),
	anchor: z.string(),
	capability: z.string(),
	order: z.number(),
	feedback: z.object({
		loading: z.string(),
		success: z.string(),
		error: z.string(),
	}),
});
const manifestFields = z.object({
	id: z.string(),
	name: z.string(),
	version: z.string(),
	stability: z.string(),
	description: z.string(),
	tagline: z.string(),
	author: z.object({ name: z.string(), url: z.string() }),
	category: z.string(),
	tags: z.array(z.string()),
	keywords: z.array(z.string()),
	icon: z.string(),
	engines: z.record(z.string(), z.string()),
	surfaces: z.record(z.string(), z.object({ support: z.string() })),
	permission_grants: z.array(z.string()),
	activation_events: z.array(z.string()),
	runnables: z.array(appResponseValueSchema),
	contributes: z.object({ context_menu_items: z.array(menuItem) }),
});
/** Every actual shipped artifact field is validated; extra metadata and raw refs stay intact. */
export const killSwitchManifestSchema = z.custom<
	z.output<typeof manifestFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		manifestFields.safeParse(value).success
);
const hostCallFields = z.object({
	method: z.string(),
	args: appResponseValueSchema,
});
/** Native JSON POST /plugins/:id/host writer: method plus the original serialized args. */
export const killSwitchHostCallSchema = z.custom<
	z.output<typeof hostCallFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		hostCallFields.safeParse(value).success
);
