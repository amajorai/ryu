import { rawViewContributionSchema } from "@ryu/app-host/views";
import { z } from "zod";

export const pluginCompanionWireSchema = z.object({
	approved_grants: z.array(z.string()).catch([]),
	default_csp_enforced: z.boolean().catch(true),
	has_ui: z.boolean().catch(false),
	icon: z.string().nullable().catch(null),
	id: z.string(),
	label: z.string().optional().catch(undefined),
	name: z.string().optional().catch(undefined),
	plugin_id: z.string().catch(""),
	shortcut: z.string().nullable().catch(null),
});

export const pluginViewWireSchema = rawViewContributionSchema;

export const pluginContributionsSchema = z.object({
	companions: z
		.array(pluginCompanionWireSchema.nullable().catch(null))
		.optional(),
	views: z.array(pluginViewWireSchema.nullable().catch(null)).optional(),
});

export const hostErrorSchema = z.object({
	error: z
		.object({
			code: z
				.enum([
					"denied",
					"not_found",
					"over_budget",
					"server_error",
					"invalid_args",
				])
				.optional()
				.catch(undefined),
			message: z.string().optional().catch(undefined),
		})
		.optional(),
});

export const hostResultSchema = z.object({ result: z.json().optional() });
export const uiBundleSchema = z.object({
	code: z.string().nullable().catch(null),
});
export const hostStreamPartSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text-delta"), delta: z.string() }),
	z.object({
		type: z.literal("error"),
		errorText: z.string().catch("agent stream error"),
	}),
]);
