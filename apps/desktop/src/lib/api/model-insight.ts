import { z } from "zod";
/**
 * Best-effort model hover-card insight via Core (`/api/models/insight`).
 * Cascade: OpenRouter first for OpenRouter-routed models, models.dev otherwise,
 * then Artificial Analysis. Returns `null` when every source misses — the picker
 * simply skips the hover card.
 */

import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";

export interface ModelInsight {
	aaKeyPresent: boolean;
	aaMatchedName?: string | null;
	contextTokens?: number | null;
	costInputPer1m?: number | null;
	costOutputPer1m?: number | null;
	description?: string | null;
	id: string;
	intelligenceIndex?: number | null;
	knowledge?: string | null;
	maxOutputTokens?: number | null;
	modalitiesInput: string[];
	modalitiesOutput: string[];
	name: string;
	outputTokensPerSecond?: number | null;
	reasoning?: boolean | null;
	scoreContext?: number | null;
	scoreCost?: number | null;
	scoreIntelligence?: number | null;
	scoreSpeed?: number | null;
	source: string;
	timeToFirstTokenS?: number | null;
	toolCall?: boolean | null;
}

export async function getModelInsight(
	target: ApiTarget,
	model: string,
	provider?: string | null
): Promise<ModelInsight | null> {
	const trimmed = model.trim();
	if (!trimmed) {
		return null;
	}
	try {
		const params = new URLSearchParams({ model: trimmed });
		if (provider?.trim()) {
			params.set("provider", provider.trim());
		}
		const json = await request(
			target,
			`/api/models/insight?${params.toString()}`,
			undefined,
			getModelInsightResponseSchema
		);
		return json.insight ?? null;
	} catch {
		return null;
	}
}

const modelInsightResponseSchema = z
	.object({
		aaKeyPresent: z.boolean(),
		aaMatchedName: z.union([z.null(), z.string()]).optional(),
		contextTokens: z.union([z.null(), z.number()]).optional(),
		costInputPer1m: z.union([z.null(), z.number()]).optional(),
		costOutputPer1m: z.union([z.null(), z.number()]).optional(),
		description: z.union([z.null(), z.string()]).optional(),
		id: z.string(),
		intelligenceIndex: z.union([z.null(), z.number()]).optional(),
		knowledge: z.union([z.null(), z.string()]).optional(),
		maxOutputTokens: z.union([z.null(), z.number()]).optional(),
		modalitiesInput: z.array(z.string()),
		modalitiesOutput: z.array(z.string()),
		name: z.string(),
		outputTokensPerSecond: z.union([z.null(), z.number()]).optional(),
		reasoning: z.union([z.null(), z.boolean()]).optional(),
		scoreContext: z.union([z.null(), z.number()]).optional(),
		scoreCost: z.union([z.null(), z.number()]).optional(),
		scoreIntelligence: z.union([z.null(), z.number()]).optional(),
		scoreSpeed: z.union([z.null(), z.number()]).optional(),
		source: z.string(),
		timeToFirstTokenS: z.union([z.null(), z.number()]).optional(),
		toolCall: z.union([z.null(), z.boolean()]).optional(),
	})
	.passthrough();

const getModelInsightResponseSchema = z
	.object({
		insight: z.union([z.null(), modelInsightResponseSchema]).optional(),
	})
	.passthrough();
