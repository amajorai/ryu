import { z } from "zod";

/** Legacy aggregation responses predate Core's complete usage rollups. */
export const legacyOrganizationUsageResponseSchema = z.object({
	capped: z.boolean(),
	events: z.array(
		z.object({
			error: z.boolean(),
			inputTokens: z.number().nonnegative(),
			latencyMs: z.number().nonnegative(),
			memberId: z.string().nullable(),
			model: z.string(),
			nodeId: z.string(),
			outputTokens: z.number().nonnegative(),
			provider: z.string(),
			requestId: z.string().nullish(),
			source: z
				.enum(["managed", "byok", "self_hosted", "local", "unknown"])
				.nullish(),
			timestamp: z
				.string()
				.refine((value) => Number.isFinite(Date.parse(value))),
		})
	),
});
/** This tag only selects a decoder; the complete canonical rollup is parsed next. */
export const organizationUsageRollupTagSchema = z.object({
	kind: z.literal("rollup"),
});
