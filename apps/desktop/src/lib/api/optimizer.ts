// apps/desktop/src/lib/api/optimizer.ts
//
// Typed client for Core's agent optimizer (`/api/agents/:id/optimizations*`).
// Core reads the agent's recent sessions, replays a sample on cheaper models
// through the Gateway eval runner, and records recommendations. Applying one goes
// through the normal agent update path, so agent version history can undo it.

import { z } from "zod";

import { ApiError, type ApiTarget, request } from "./client.ts";

export interface OptimizerReadiness {
	ready: boolean;
	required: number;
	sessions: number;
}

export interface OptimizerModelScore {
	cases: number;
	costMicroUsd: number | null;
	errors: number;
	meanLatencyMs: number | null;
	model: string;
	quality: number | null;
}

export interface OptimizerEvidence {
	baselineCostMicroUsd?: number;
	baselineQuality?: number;
	candidateCostMicroUsd?: number;
	candidateQuality?: number;
	cases: number;
	models?: OptimizerModelScore[];
	/** Fractional cost reduction in [0, 1]. */
	savings?: number;
	sessions: number;
	toolCalls?: Record<string, number>;
	/** True when the change was replayed and judged; false for usage evidence. */
	verified: boolean;
}

export type OptimizerChange =
	| { from: string; to: string; type: "set_model" }
	| { keep: string[]; remove: string[]; type: "remove_tools" };

export type OptimizerStatus =
	| "pending"
	| "applied"
	| "dismissed"
	| "superseded";

export interface OptimizerRecommendation {
	agentId: string;
	change: OptimizerChange;
	createdAt: string;
	decidedAt?: string;
	evidence: OptimizerEvidence;
	id: string;
	kind: "model" | "tools";
	status: OptimizerStatus;
	summary: string;
	title: string;
}

export interface OptimizerAnalysis {
	at: string;
	candidates: string[];
	cases: number;
	notes: string[];
	sessions: number;
}

export interface AgentOptimizations {
	historyUnavailable?: boolean;
	lastAnalysis: OptimizerAnalysis | null;
	readiness: OptimizerReadiness;
	recommendations: OptimizerRecommendation[];
	/** Committed operations whose suggestion acknowledgement still needs recovery. */
	recoveryRecommendations?: OptimizerRecommendation[];
}

export function optimizationRecoveryRequired(
	cause: unknown,
	id: string
): boolean {
	if (!(cause instanceof ApiError) || cause.status !== 500) {
		return false;
	}
	const parsed = z
		.object({
			agentUpdated: z.literal(true),
			recoveryRequired: z.literal(true),
			recommendationId: z.string(),
		})
		.safeParse(cause.body);
	return parsed.success && parsed.data.recommendationId === id;
}

export interface AnalyzeOptions {
	/** Models to compare against the current one; empty picks cheaper ones. */
	candidateModels?: string[];
	/** How far below the current model's judged quality a candidate may score. */
	qualityTolerance?: number;
}

function optimizationsPath(agentId: string): string {
	return `/api/agents/${encodeURIComponent(agentId)}/optimizations`;
}

export async function fetchAgentOptimizations(
	target: ApiTarget,
	agentId: string
): Promise<AgentOptimizations> {
	return await request(
		target,
		optimizationsPath(agentId),
		undefined,
		agentOptimizationsResponseSchema
	);
}

export async function analyzeAgentOptimizations(
	target: ApiTarget,
	agentId: string,
	options: AnalyzeOptions = {},
	signal?: AbortSignal
): Promise<AgentOptimizations> {
	return await request(
		target,
		`${optimizationsPath(agentId)}/analyze`,
		{ method: "POST", body: options, signal },
		agentOptimizationsResponseSchema
	);
}

export async function applyAgentOptimization(
	target: ApiTarget,
	agentId: string,
	recommendationId: string
): Promise<{ recommendation: OptimizerRecommendation }> {
	return await request(
		target,
		`${optimizationsPath(agentId)}/${encodeURIComponent(recommendationId)}/apply`,
		{ method: "POST" },
		applyAgentOptimizationResponseSchema
	);
}

export async function dismissAgentOptimization(
	target: ApiTarget,
	agentId: string,
	recommendationId: string
): Promise<{ recommendation: OptimizerRecommendation }> {
	return await request(
		target,
		`${optimizationsPath(agentId)}/${encodeURIComponent(recommendationId)}/dismiss`,
		{ method: "POST" },
		dismissAgentOptimizationResponseSchema
	);
}

/** Format a micro-USD amount for display (e.g. 1_234 → "$0.0012"). */
export function formatMicroUsd(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return "unpriced";
	}
	const usd = value / 1_000_000;
	return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

export function formatShare(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return "not scored";
	}
	return `${Math.round(value * 100)}%`;
}

const optimizerAnalysisResponseSchema = z
	.object({
		at: z.string(),
		candidates: z.array(z.string()),
		cases: z.number(),
		notes: z.array(z.string()),
		sessions: z.number(),
	})
	.passthrough();

const optimizerReadinessResponseSchema = z
	.object({ ready: z.boolean(), required: z.number(), sessions: z.number() })
	.passthrough();

const response1RecommendationsItemChangeSchema = z
	.object({ from: z.string(), to: z.string(), type: z.literal("set_model") })
	.passthrough();

const response1RecommendationsItemChange1Schema = z
	.object({
		keep: z.array(z.string()),
		remove: z.array(z.string()),
		type: z.literal("remove_tools"),
	})
	.passthrough();

const optimizerModelScoreResponseSchema = z
	.object({
		cases: z.number(),
		costMicroUsd: z.union([z.null(), z.number()]),
		errors: z.number(),
		meanLatencyMs: z.union([z.null(), z.number()]),
		model: z.string(),
		quality: z.union([z.null(), z.number()]),
	})
	.passthrough();

const optimizerEvidenceResponseSchema = z
	.object({
		baselineCostMicroUsd: z.number().optional(),
		baselineQuality: z.number().optional(),
		candidateCostMicroUsd: z.number().optional(),
		candidateQuality: z.number().optional(),
		cases: z.number(),
		models: z.array(optimizerModelScoreResponseSchema).optional(),
		savings: z.number().optional(),
		sessions: z.number(),
		toolCalls: z.record(z.string(), z.number()).optional(),
		verified: z.boolean(),
	})
	.passthrough();

const optimizerRecommendationResponseSchema = z
	.object({
		agentId: z.string(),
		change: z.union([
			response1RecommendationsItemChangeSchema,
			response1RecommendationsItemChange1Schema,
		]),
		createdAt: z.string(),
		decidedAt: z.string().optional(),
		evidence: optimizerEvidenceResponseSchema,
		id: z.string(),
		kind: z.union([z.literal("model"), z.literal("tools")]),
		status: z.union([
			z.literal("pending"),
			z.literal("applied"),
			z.literal("dismissed"),
			z.literal("superseded"),
		]),
		summary: z.string(),
		title: z.string(),
	})
	.passthrough();

const agentOptimizationsResponseSchema = z
	.object({
		historyUnavailable: z.boolean().optional(),
		lastAnalysis: z.union([z.null(), optimizerAnalysisResponseSchema]),
		readiness: optimizerReadinessResponseSchema,
		recommendations: z.array(optimizerRecommendationResponseSchema),
		recoveryRecommendations: z
			.array(optimizerRecommendationResponseSchema)
			.optional(),
	})
	.passthrough();

const applyAgentOptimizationResponseSchema = z
	.object({ recommendation: optimizerRecommendationResponseSchema })
	.passthrough();

const dismissAgentOptimizationResponseSchema = z
	.object({ recommendation: optimizerRecommendationResponseSchema })
	.passthrough();
