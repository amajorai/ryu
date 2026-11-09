// apps/desktop/src/lib/api/memory-dream.ts
//
// Typed client for Dream, the Memory app's reviewed chat-to-memory pass
// (`/api/memory/dream/review`). Dream proposes memories; nothing is written
// until the user accepts a proposal. Wire shapes are snake_case; this module
// maps them to camelCase like the core memory client in `memory.ts`.

import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { type ApiTarget, request } from "./client.ts";
import {
	type Memory,
	type MemoryWire,
	memoriesResponseSchema,
	toMemory,
} from "./memory.ts";

const proposalsResponseSchema = z.looseObject({
	created_at: z.number().optional(),
	current: z.union([z.null(), memoriesResponseSchema]).optional(),
	id: z.string(),
	operation: z.string().optional(),
	proposed: memoriesResponseSchema,
	reason: z.union([z.null(), z.string()]).optional(),
	source: z.union([z.null(), z.string()]).optional(),
	status: z.string().optional(),
	target_memory_id: z.union([z.null(), z.string()]).optional(),
});
const reviewResponseSchema = z.looseObject({
	generated_at: z.number().optional(),
	mode: z.string().optional(),
	proposals: z.array(proposalsResponseSchema).optional(),
	recent: z.array(proposalsResponseSchema).optional(),
	summary: z.union([z.null(), z.string()]).optional(),
});
const jsonResponseSchema8 = z.looseObject({
	review: reviewResponseSchema.optional(),
	proposals: z.array(proposalsResponseSchema).optional(),
});
const jsonResponseSchema9 = z.looseObject({
	review: reviewResponseSchema.optional(),
	proposals: z.array(proposalsResponseSchema).optional(),
});
const jsonResponseSchema10 = z.looseObject({ memory: memoriesResponseSchema });
const settingsResponseSchema = z.looseObject({
	automatic: z.boolean().optional(),
	quiet_hours_end: z.number().optional(),
	quiet_hours_start: z.number().optional(),
});
const jsonResponseSchema11 = z.looseObject({
	settings: settingsResponseSchema.optional(),
});
const jsonResponseSchema12 = z.looseObject({
	settings: settingsResponseSchema.optional(),
});

/** The review cadence Dream can use when it looks for durable memories. */
export type DreamReviewMode = "manual" | "automatic";

/** A proposed memory returned by Dream before it is written to the store. */
/**
 * What accepting a proposal does: `create` saves a new memory, `revise`
 * replaces `current` with `proposed`, and `archive` retires `current` from
 * recall without deleting it (its `proposed` body is empty and unused).
 */
export type MemoryProposalOperation = "create" | "revise" | "archive";

export interface MemoryProposal {
	createdAt: number;
	current: Memory | null;
	id: string;
	operation: MemoryProposalOperation;
	proposed: Memory;
	reason: string | null;
	source: string | null;
	status: MemoryProposalStatus;
	targetMemoryId: string | null;
}

/** `applied` proposals were accepted; `rolled_back` ones were undone. */
export type MemoryProposalStatus =
	| "pending"
	| "accepted"
	| "applied"
	| "rejected"
	| "rolled_back";

const PROPOSAL_STATUSES: MemoryProposalStatus[] = [
	"accepted",
	"applied",
	"rejected",
	"rolled_back",
];

export interface DreamReview {
	generatedAt: number;
	mode: DreamReviewMode;
	proposals: MemoryProposal[];
	/** Proposals accepted in the last week that can still be undone. */
	recent: MemoryProposal[];
	summary: string | null;
}

export interface DreamSettings {
	automatic: boolean;
	quietHoursEnd: number;
	quietHoursStart: number;
}

interface MemoryProposalWire {
	created_at?: number;
	current?: MemoryWire | null;
	id: string;
	operation?: string;
	proposed: MemoryWire;
	reason?: string | null;
	source?: string | null;
	status?: string;
	target_memory_id?: string | null;
}

interface DreamSettingsWire {
	automatic?: boolean;
	quiet_hours_end?: number;
	quiet_hours_start?: number;
}

function toReviewMode(value: string | undefined): DreamReviewMode {
	return value === "automatic" ? "automatic" : "manual";
}

/**
 * The wire operation. Nodes from before `operation` was sent imply it: a
 * proposal with a `current` memory was a revision.
 */
function toOperation(
	value: string | undefined,
	hasCurrent: boolean
): MemoryProposalOperation {
	if (value === "create" || value === "revise" || value === "archive") {
		return value;
	}
	return hasCurrent ? "revise" : "create";
}

function toProposal(m: MemoryProposalWire): MemoryProposal {
	return {
		createdAt: m.created_at ?? 0,
		current: m.current ? toMemory(m.current) : null,
		id: m.id,
		operation: toOperation(m.operation, Boolean(m.current)),
		reason: m.reason ?? null,
		proposed: toMemory(m.proposed),
		source: m.source ?? null,
		status:
			PROPOSAL_STATUSES.find((status) => status === m.status) ?? "pending",
		targetMemoryId: m.target_memory_id ?? null,
	};
}

// ── Dream review ──────────────────────────────────────────────────────────────
// These endpoints are intentionally kept in the desktop client until the Core
// surface lands. Keeping the wire contract here lets the UI ship against the
// expected routes without inventing a second transport or leaking snake_case
// into components.

const DREAM_REVIEW_PATH = "/api/memory/dream/review";

export async function getDreamReview(target: ApiTarget): Promise<DreamReview> {
	const json = await request(
		target,
		DREAM_REVIEW_PATH,
		undefined,
		jsonResponseSchema8
	);
	const review = json.review ?? {};
	return {
		generatedAt: review.generated_at ?? 0,
		mode: toReviewMode(review.mode),
		proposals: (review.proposals ?? json.proposals ?? []).map(toProposal),
		recent: (review.recent ?? []).map(toProposal),
		summary: review.summary ?? null,
	};
}

export async function runDreamReview(
	target: ApiTarget,
	mode: DreamReviewMode = "manual"
): Promise<DreamReview> {
	const json = await request(
		target,
		DREAM_REVIEW_PATH,
		{ method: "POST", body: { mode } },
		jsonResponseSchema9
	);
	const review = json.review ?? {};
	return {
		generatedAt: review.generated_at ?? Date.now(),
		mode: toReviewMode(review.mode ?? mode),
		proposals: (review.proposals ?? json.proposals ?? []).map(toProposal),
		recent: (review.recent ?? []).map(toProposal),
		summary: review.summary ?? null,
	};
}

export async function acceptMemoryProposal(
	target: ApiTarget,
	proposalId: string
): Promise<Memory> {
	const json = await request(
		target,
		`${DREAM_REVIEW_PATH}/proposals/${encodeURIComponent(proposalId)}/accept`,
		{ method: "POST" },
		jsonResponseSchema10
	);
	return toMemory(json.memory);
}

export async function rejectMemoryProposal(
	target: ApiTarget,
	proposalId: string
): Promise<void> {
	await request(
		target,
		`${DREAM_REVIEW_PATH}/proposals/${encodeURIComponent(proposalId)}/reject`,
		{ method: "POST" },
		gatewayJsonValueSchema
	);
}

/**
 * Undo an accepted proposal: the memory it wrote is retracted and the memory
 * it replaced or archived is active again. Core refuses (409) once a later
 * change built on it.
 */
export async function rollbackMemoryProposal(
	target: ApiTarget,
	proposalId: string
): Promise<void> {
	await request(
		target,
		`${DREAM_REVIEW_PATH}/proposals/${encodeURIComponent(proposalId)}/rollback`,
		{ method: "POST" },
		gatewayJsonValueSchema
	);
}

export async function getDreamSettings(
	target: ApiTarget
): Promise<DreamSettings> {
	const json = await request(
		target,
		`${DREAM_REVIEW_PATH}/settings`,
		undefined,
		jsonResponseSchema11
	);
	const settings = json.settings ?? {};
	return {
		automatic: settings.automatic ?? false,
		quietHoursEnd: settings.quiet_hours_end ?? 8,
		quietHoursStart: settings.quiet_hours_start ?? 22,
	};
}

export async function updateDreamSettings(
	target: ApiTarget,
	settings: Partial<DreamSettings>
): Promise<DreamSettings> {
	const body: DreamSettingsWire = {};
	if (settings.automatic !== undefined) {
		body.automatic = settings.automatic;
	}
	if (settings.quietHoursStart !== undefined) {
		body.quiet_hours_start = settings.quietHoursStart;
	}
	if (settings.quietHoursEnd !== undefined) {
		body.quiet_hours_end = settings.quietHoursEnd;
	}
	const json = await request(
		target,
		`${DREAM_REVIEW_PATH}/settings`,
		{ method: "PATCH", body },
		jsonResponseSchema12
	);
	const next = json.settings ?? {};
	return {
		automatic: next.automatic ?? settings.automatic ?? false,
		quietHoursEnd: next.quiet_hours_end ?? settings.quietHoursEnd ?? 8,
		quietHoursStart: next.quiet_hours_start ?? settings.quietHoursStart ?? 22,
	};
}
