import { z } from "zod";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { request } from "@/src/lib/api/client.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";

export interface SubscriptionCostModelUsage {
	estimatedCostMicroUsd: number | null;
	inputTokens: number;
	missingInputTurns: number;
	missingOutputTurns: number;
	modelId: string;
	outputTokens: number;
	priceSource: "models.dev" | null;
	turns: number;
	unpricedInputTokens: number;
	unpricedOutputTokens: number;
}

export interface SubscriptionCostAccountUsage {
	accountId: string;
	estimatedCostMicroUsd: number | null;
	inputTokens: number;
	missingInputTurns: number;
	missingOutputTurns: number;
	models: SubscriptionCostModelUsage[];
	outputTokens: number;
	providerId: string;
	turns: number;
	unpricedInputTokens: number;
	unpricedOutputTokens: number;
}

export interface SubscriptionCostUsageSummary {
	accounts: SubscriptionCostAccountUsage[];
	enabled: boolean;
	month: string;
}

export async function fetchSubscriptionCostUsage(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SubscriptionCostUsageSummary> {
	return request<SubscriptionCostUsageSummary>(
		target,
		"/api/usage/subscription-costs",
		{ signal },
		subscriptionCostUsageSummaryResponseCodec
	);
}

export async function setSubscriptionCostTracking(
	target: ApiTarget,
	enabled: boolean
): Promise<{ enabled: boolean }> {
	return request<{ enabled: boolean }>(
		target,
		"/api/usage/subscription-costs/settings",
		{ body: { enabled }, method: "PUT" },
		responseCodec1
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const subscriptionCostModelUsageResponseCodec = z
	.object({
		estimatedCostMicroUsd: z.union([z.number(), z.null()]),
		inputTokens: z.number(),
		missingInputTurns: z.number(),
		missingOutputTurns: z.number(),
		modelId: z.string(),
		outputTokens: z.number(),
		priceSource: z.union([z.literal("models.dev"), z.null()]),
		turns: z.number(),
		unpricedInputTokens: z.number(),
		unpricedOutputTokens: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const subscriptionCostAccountUsageResponseCodec = z
	.object({
		accountId: z.string(),
		estimatedCostMicroUsd: z.union([z.number(), z.null()]),
		inputTokens: z.number(),
		missingInputTurns: z.number(),
		missingOutputTurns: z.number(),
		models: z.array(subscriptionCostModelUsageResponseCodec),
		outputTokens: z.number(),
		providerId: z.string(),
		turns: z.number(),
		unpricedInputTokens: z.number(),
		unpricedOutputTokens: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const subscriptionCostUsageSummaryResponseCodec = z
	.object({
		accounts: z.array(subscriptionCostAccountUsageResponseCodec),
		enabled: z.boolean(),
		month: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec1 = z
	.object({ enabled: z.boolean() })
	.catchall(gatewayJsonValueSchema);
