// apps/desktop/src/lib/api/orgs-types.ts
//
// Wire types for the organizations API in `./orgs.ts`, which re-exports them.

import type { PluginDocument } from "./plugin-wire-values.ts";

export interface OrgSummary {
	/** Whether the caller may move credits OUT of this org (owner/admin). */
	canSendFrom: boolean;
	id: string;
	/** True for the caller's personal org — where referral rewards are paid. */
	isPersonal: boolean;
	name: string;
	role: string | null;
	slug: string;
}

export interface TransferableGrant {
	expiresAt: string | null;
	id: string;
	originalMicroUsd: number;
	pool: string;
	remainingMicroUsd: number;
}

export interface TransferableView {
	orgs: OrgSummary[];
	source: {
		grants: TransferableGrant[];
		orgId: string;
		topupMicroUsd: number;
	} | null;
}

export interface OrgListEntry {
	createdAt: string | null;
	id: string;
	/**
	 * True for the caller's personal workspace. Server-computed (earliest
	 * membership) rather than derived here from the slug, so there is one rule
	 * for it rather than a desktop copy that can drift — the same field, from the
	 * same helper, that `/api/credits/transferable` puts on {@link OrgSummary}.
	 */
	isPersonal: boolean;
	/**
	 * The org's uploaded logo, exactly as the web dashboard's settings dialog
	 * writes it. `null` when nobody has set one, which is a real answer and not a
	 * failure: the UI falls back to the generative avatar seeded by `id`, the same
	 * placeholder the web shows.
	 */
	logo: string | null;
	name: string;
	role: string | null;
	slug: string;
}

export interface OrgTeamEntry {
	id: string;
	name: string;
}

export type OrganizationAuditActorType = "gateway" | "system" | "user";

/** One bounded, redacted event returned by the organization audit projections. */
export interface OrganizationAuditEntry {
	action: string;
	actor: {
		email: string | null;
		id: string | null;
		name: string | null;
		type: OrganizationAuditActorType;
	};
	agentId: string | null;
	details: PluginDocument;
	error: string | null;
	eventType: string;
	feature: string | null;
	id: string;
	requestId: string | null;
	scope: "gateway" | "org";
	sessionId: string | null;
	target: string;
	targetId: string | null;
	timestamp: string;
}

/** Gateway request/tool event shape used by the Agent passport. */
export interface OrganizationGatewayActivityEntry {
	actorId: string | null;
	agentId: string | null;
	apiKey: string | null;
	backend: string | null;
	command: string | null;
	costMicroUsd: number | null;
	durationMs: number | null;
	error: string | null;
	evalScore: number | null;
	eventType: string;
	feature: string | null;
	gatewayId: string;
	id: string;
	inputTokens: number;
	latencyMs: number;
	managedInference: boolean;
	model?: string | null;
	outputTokens: number;
	projectId: string | null;
	provider: string;
	providerCostMicroUsd: number | null;
	requestId: string;
	sessionId: string | null;
	teamId: string | null;
	timestamp: string;
	userName: string | null;
	widgetInstanceId?: string | null;
}
