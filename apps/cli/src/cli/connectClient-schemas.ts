// The schemas every Connect and tool catalog answer is parsed with before it
// is used, and the types the CLI reads from them. Split from `connectClient.ts`.

import { z } from "zod";

const priceSchema = z.object({
	amountMicroUsd: z.number(),
	estimated: z.boolean(),
	per: z.literal("call"),
	source: z.string(),
});

const catalogSchema = z
	.object({
		source: z.string().optional(),
		state: z.string().optional(),
	})
	.loose();

const reliabilitySchema = z
	.object({
		sufficient: z.boolean().optional(),
		successRate: z.number().nullable().optional(),
		p50Ms: z.number().nullable().optional(),
		p95Ms: z.number().nullable().optional(),
	})
	.loose();

export const toolDescriptorSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		kind: z.string(),
		provider: z.string(),
		tier: z.string(),
		toolkit: z.string().optional(),
		price: priceSchema,
		score: z.number().optional(),
		catalog: catalogSchema.optional(),
		reliability: reliabilitySchema.optional(),
		lifecycle: z.string().optional(),
	})
	.loose();
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

export const searchResultSchema = z.object({
	object: z.literal("list"),
	data: z.array(toolDescriptorSchema),
	didYouMean: z.array(z.string()).optional(),
	missedTerms: z.array(z.string()).optional(),
	partial: z.literal(true).optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const describedToolSchema = toolDescriptorSchema.extend({
	parameters: z.unknown(),
});
export type DescribedTool = z.infer<typeof describedToolSchema>;

export const balanceSchema = z.object({
	object: z.literal("balance"),
	availableMicroUsd: z.number().nullable(),
	billed: z.boolean(),
	heldMicroUsd: z.number(),
	headroomMicroUsd: z.number().nullable(),
	suspended: z.boolean(),
	topUpUrl: z.string().nullable(),
	unsettledMicroUsd: z.number().nullable(),
	unsettledSince: z.string().nullable(),
});
export type Balance = z.infer<typeof balanceSchema>;

export const toolRequestReceiptSchema = z
	.object({
		ok: z.literal(true),
		status: z.string(),
		id: z.string().optional(),
	})
	.loose();
export type ToolRequestReceipt = z.infer<typeof toolRequestReceiptSchema>;

/** The money fields every Connect call answer carries. */
export const callMoneySchema = z.object({
	ryuCallId: z.string(),
	costMicroUsd: z.number(),
	chargedMicroUsd: z.number().nullable(),
	estimated: z.boolean(),
	exceededMaxCost: z.boolean(),
	ledgerRefId: z.string().nullable(),
	priceSource: z.string().nullable(),
});

export const callAnswerSchema = callMoneySchema
	.extend({
		ok: z.boolean(),
		result: z
			.object({
				content: z.array(z.unknown()).optional(),
				isError: z.boolean().optional(),
				structuredContent: z.unknown().optional(),
			})
			.loose(),
	})
	.loose();
export type CallAnswer = z.infer<typeof callAnswerSchema>;

export const healthSchema = z
	.object({
		service: z.string(),
		version: z.string().optional(),
		apiVersion: z.string().optional(),
	})
	.loose();
export type Health = z.infer<typeof healthSchema>;

const costSchema = z
	.object({
		basis: z.string(),
		usd: z.number().nullable(),
		value: z.number().nullable(),
		currency: z.string(),
		free: z.boolean(),
	})
	.loose();
const browseEndpointSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		provider: z.string(),
		provider_display: z.string(),
		source: z.string(),
		cost: costSchema.nullable(),
		verification: z.object({ state: z.string() }).loose(),
		platform_eligible: z.boolean(),
	})
	.loose();
const browseSummarySchema = z
	.object({
		slug: z.string(),
		label: z.string(),
		endpoints: z.number(),
		verified_endpoints: z.number(),
		capabilities: z.number(),
		providers: z.array(z.string()),
		price_from: costSchema.nullable(),
		source: z.string(),
	})
	.loose();
export const platformIndexSchema = z
	.object({
		type: z.literal("ryu.tool_catalog.platforms"),
		generated_at: z.string(),
		platforms: z.array(browseSummarySchema),
	})
	.loose();
export const platformDetailSchema = browseSummarySchema
	.extend({
		type: z.literal("ryu.tool_catalog.platform"),
		domains: z.array(
			z
				.object({
					id: z.string(),
					label: z.string(),
					rows: z.array(
						z
							.object({
								capability: z.string(),
								capability_name: z.string(),
								cheapest_endpoint: z.string().nullable(),
								endpoints: z.array(browseEndpointSchema),
							})
							.loose()
					),
				})
				.loose()
		),
	})
	.loose();

/** The subset of `@ryuhq/protocol/tool-catalog-browse`'s shapes the CLI reads. */
export type PlatformIndex = z.infer<typeof platformIndexSchema>;
export type PlatformDetail = z.infer<typeof platformDetailSchema>;

export const refusalSchema = z
	.object({
		code: z.string().optional(),
		error: z.string().optional(),
	})
	.loose();
