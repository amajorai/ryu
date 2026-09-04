import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";
import type { AgentSelection } from "./preferences.ts";

export type GatewayOnboardingReason =
	| "local_node"
	| "personal_node"
	| "managed_node"
	| "shared_acl_node"
	| "shared_node_admin"
	| "not_node_owner"
	| "profile_not_eligible"
	| "ready";

/** The node-level setup mode selected during first-run onboarding. */
export type NodeSetupKind = "personal" | "team";

/** Shared company context stored on a team node. */
export interface NodeOnboardingPersonalization {
	companyContext: string;
	companyKnowledgeEnabled: boolean;
}

/** Durable onboarding state returned by the active Core node. */
export interface NodeOnboardingState {
	completed: boolean;
	completedAtMs: number | null;
	personalization: NodeOnboardingPersonalization;
	setupKind: NodeSetupKind | null;
	version: number;
}

/** Node state plus the live permission used by Gateway settings. */
export interface NodeOnboardingSnapshot extends NodeOnboardingState {
	canConfigure: boolean;
}

export interface GatewayOnboardingAccess {
	allowed: boolean;
	managedNode: boolean;
	reason: GatewayOnboardingReason | string;
	scope: "org" | "team" | "personal" | null;
}

export interface ProfileAvailability {
	allowed: boolean;
	completed: boolean;
	reason: GatewayOnboardingReason | string;
}

export type ProfileJobState =
	| "queued"
	| "building"
	| "completed"
	| "failed"
	| "cancelled";

/** A reviewable agent recipe returned by Core after profile bootstrap. */
export interface OnboardingAgentSuggestion {
	description: string;
	id: string;
	name: string;
	reason: string;
	systemPrompt: string;
	title: string;
	tools: string[];
}

export interface ProfileJobStatus {
	agentSuggestions: OnboardingAgentSuggestion[];
	conversationId: string | null;
	error: string | null;
	id: string;
	materialized: boolean;
	startedAtMs: number;
	state: ProfileJobState;
}

interface ProfileJobWire {
	agentSuggestions?: OnboardingAgentSuggestion[];
	conversationId?: string | null;
	error?: string | null;
	id: string;
	materialized?: boolean;
	startedAtMs?: number;
	state: ProfileJobState;
}

function normalize(job: ProfileJobWire): ProfileJobStatus {
	return {
		agentSuggestions: job.agentSuggestions ?? [],
		conversationId: job.conversationId ?? null,
		error: job.error ?? null,
		id: job.id,
		materialized: job.materialized ?? false,
		startedAtMs: job.startedAtMs ?? Date.now(),
		state: job.state,
	};
}

export async function fetchGatewayOnboardingAccess(
	target: ApiTarget
): Promise<GatewayOnboardingAccess> {
	return request<GatewayOnboardingAccess>(target, "/api/onboarding/access");
}

/** Read node onboarding state; a missing/old route is handled by the caller. */
export async function fetchNodeOnboardingState(
	target: ApiTarget
): Promise<NodeOnboardingSnapshot> {
	return request<NodeOnboardingSnapshot>(target, "/api/onboarding/state", {
		signal: AbortSignal.timeout(10_000),
	});
}

export interface SaveNodeOnboardingStateInput {
	companyContext: string;
	companyKnowledgeEnabled: boolean;
	completed: boolean;
	setupKind: NodeSetupKind;
}

/** Persist the selected node mode/context or mark node onboarding complete. */
export async function saveNodeOnboardingState(
	target: ApiTarget,
	input: SaveNodeOnboardingStateInput
): Promise<NodeOnboardingSnapshot> {
	return request<NodeOnboardingSnapshot>(target, "/api/onboarding/state", {
		body: input,
		method: "PUT",
		signal: AbortSignal.timeout(10_000),
	});
}

/** Clear only the node's onboarding state; durable chats and memories remain. */
export async function resetNodeOnboardingState(
	target: ApiTarget
): Promise<NodeOnboardingSnapshot> {
	return request<NodeOnboardingSnapshot>(target, "/api/onboarding/state", {
		method: "DELETE",
		signal: AbortSignal.timeout(10_000),
	});
}

export async function fetchProfileAvailability(
	target: ApiTarget
): Promise<ProfileAvailability> {
	return request<ProfileAvailability>(
		target,
		"/api/onboarding/profile/availability"
	);
}

export interface StartProfileJobInput {
	cloudSelection: AgentSelection;
	importedConversationIds: string[];
	recentDays: number;
	shareUserOrg: boolean;
	sourceIds: string[];
}

export async function startProfileJob(
	target: ApiTarget,
	input: StartProfileJobInput
): Promise<ProfileJobStatus> {
	const job = await request<ProfileJobWire>(
		target,
		"/api/onboarding/profile/start",
		{
			method: "POST",
			body: input,
		}
	);
	return normalize(job);
}

export async function getProfileJobStatus(
	target: ApiTarget,
	jobId: string
): Promise<ProfileJobStatus> {
	const job = await request<ProfileJobWire>(
		target,
		`/api/onboarding/profile/status/${encodeURIComponent(jobId)}`
	);
	return normalize(job);
}

export async function cancelProfileJob(
	target: ApiTarget,
	jobId: string
): Promise<ProfileJobStatus> {
	const job = await request<ProfileJobWire>(
		target,
		`/api/onboarding/profile/cancel/${encodeURIComponent(jobId)}`,
		{ method: "POST" }
	);
	return normalize(job);
}

export async function continueProfileJobInBackground(
	target: ApiTarget,
	jobId: string
): Promise<ProfileJobStatus> {
	const job = await request<ProfileJobWire>(
		target,
		`/api/onboarding/profile/background/${encodeURIComponent(jobId)}`,
		{ method: "POST" }
	);
	return normalize(job);
}
