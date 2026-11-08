// packages/core-client/src/vault/password-manager.ts
//
// Password-manager credentials: part of the Secret Vault client. `../vault.ts`
// re-exports these names and documents the wire conventions.

import type { AppJsonValue } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import type { VaultAgentTarget } from "./agent-routes.ts";
import type {
	VaultBrokerCredentialRequest,
	VaultBrokerDiscovery,
	VaultBrokerProposal,
	VaultBrokerProposalStatus,
	VaultBrokerSessionGrant,
	VaultBrokerSessionInput,
} from "./broker.ts";
import {
	vaultBrokerDiscoveryReply,
	vaultBrokerGrantReply,
	vaultBrokerProposalReply,
	vaultDeletedReply,
	vaultPmAccountReply,
	vaultPmAccountsReply,
	vaultPmApprovalsReply,
	vaultPmGrantsReply,
	vaultPmReadReply,
	vaultPmRevokeReply,
	vaultPmTestReply,
} from "./codecs-machine.ts";
import { vaultPmDecisionReply } from "./codecs-reply.ts";
import { agentRequest, query } from "./internal.ts";
import type { VaultTimestamp } from "./shared.ts";

export type VaultPasswordManagerProvider =
	| "1password-connect"
	| "1password-service-account"
	| "bitwarden-sm";

export type VaultPasswordManagerState = "connected" | "reconnect_required";

/** `once` is one use within a day; the others are lifetimes. */
export type VaultPasswordManagerGrantMode = "once" | "1h" | "24h" | "30d";

/** The first use of an `op://` / `bws://` reference by one consumer. */
export interface VaultCredentialUse {
	account: string;
	accountId: string;
	provider: VaultPasswordManagerProvider;
	ref: string;
	/** The consumer, scoped to its channel: `broker:<minter>`,
	 *  `runtime:<mcp>:<owner>`, or `read:<principal>`. */
	subject: string;
}

/** A password-manager account. Core never returns its token. */
export interface VaultPasswordManagerAccount {
	address: string | null;
	binaryPath: string | null;
	createdAt: VaultTimestamp;
	id: string;
	lastCheckedAt: VaultTimestamp | null;
	lastError: string | null;
	name: string;
	provider: VaultPasswordManagerProvider;
	state: VaultPasswordManagerState;
	updatedAt: VaultTimestamp;
}

export interface VaultPasswordManagerAccountInput {
	/** Connect server URL (required for `1password-connect`), or a Bitwarden
	 *  self-hosted server URL. */
	address?: string;
	name: string;
	provider: VaultPasswordManagerProvider;
	token: string;
}

export interface VaultPasswordManagerGrant {
	account: string;
	accountId: string;
	createdAt: VaultTimestamp;
	expiresAt: VaultTimestamp;
	grantedBy: string;
	id: string;
	mode: VaultPasswordManagerGrantMode;
	proposalId: string | null;
	ref: string;
	revokedAt: VaultTimestamp | null;
	subject: string;
	usesRemaining: number | null;
}

export interface VaultPasswordManagerTestResult {
	account: VaultPasswordManagerAccount | null;
	error?: string;
	ok: boolean;
}

/** `200` with the value, or `202` while the caller's use awaits approval
 *  (the provider was not contacted). */
export type VaultPasswordManagerReadResult =
	| {
			account: string;
			pending?: undefined;
			provider: VaultPasswordManagerProvider;
			ref: string;
			value: string;
	  }
	| { approval: VaultBrokerProposal; pending: true };

export interface VaultPasswordManagerDecisionInput {
	/** Approve only (Core defaults to `30d`). */
	grant?: VaultPasswordManagerGrantMode;
	note?: string;
}

function pmPath(suffix: string): string {
	return `/api/vault/password-managers${suffix}`;
}

/** Password-manager accounts visible to the caller (never tokens). */
export function listVaultPasswordManagerAccounts(
	target: ApiTarget
): Promise<{ accounts: VaultPasswordManagerAccount[] }> {
	return request(target, pmPath("/accounts"), {}, vaultPmAccountsReply);
}

/** Add a 1Password or Bitwarden Secrets Manager account; Core seals the
 *  token and never returns it. Needs `admin` on
 *  `sys/password-managers/<name>`. */
export function createVaultPasswordManagerAccount(
	target: ApiTarget,
	input: VaultPasswordManagerAccountInput
): Promise<{ account: VaultPasswordManagerAccount }> {
	const body: Record<string, string> = {
		name: input.name,
		provider: input.provider,
		token: input.token,
	};
	if (input.address) {
		body.address = input.address;
	}
	return request(
		target,
		pmPath("/accounts"),
		{ method: "POST", body },
		vaultPmAccountReply
	);
}

export function deleteVaultPasswordManagerAccount(
	target: ApiTarget,
	id: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		pmPath(`/accounts/${encodeURIComponent(id)}`),
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** Check connectivity and the token without reading a value. A provider
 *  failure answers `ok: false` with a sanitized error. */
export function testVaultPasswordManagerAccount(
	target: ApiTarget,
	id: string
): Promise<VaultPasswordManagerTestResult> {
	return request(
		target,
		pmPath(`/accounts/${encodeURIComponent(id)}/test`),
		{ method: "POST" },
		vaultPmTestReply
	);
}

/** Replace an account's token (reconnect). */
export function setVaultPasswordManagerToken(
	target: ApiTarget,
	id: string,
	token: string
): Promise<{ account: VaultPasswordManagerAccount }> {
	return request(
		target,
		pmPath(`/accounts/${encodeURIComponent(id)}/token`),
		{ method: "POST", body: { token } },
		vaultPmAccountReply
	);
}

/** Read an `op://` or `bws://` reference as the calling human. The first
 *  read files an approval request and answers `pending`. */
export function readVaultPasswordManagerRef(
	target: ApiTarget,
	ref: string,
	options: { environment?: string } = {}
): Promise<VaultPasswordManagerReadResult> {
	const body: Record<string, string> = { ref };
	if (options.environment) {
		body.environment = options.environment;
	}
	return request(
		target,
		pmPath("/read"),
		{ method: "POST", body },
		vaultPmReadReply
	);
}

export function listVaultPasswordManagerGrants(
	target: ApiTarget,
	filter: { all?: boolean } = {}
): Promise<{ grants: VaultPasswordManagerGrant[] }> {
	return request(
		target,
		pmPath(`/grants${query({ all: filter.all ? "true" : undefined })}`),
		{},
		vaultPmGrantsReply
	);
}

export function revokeVaultPasswordManagerGrant(
	target: ApiTarget,
	id: string
): Promise<{ grant: VaultPasswordManagerGrant; revoked: true }> {
	return request(
		target,
		pmPath(`/grants/${encodeURIComponent(id)}`),
		{ method: "DELETE" },
		vaultPmRevokeReply
	);
}

/** Credential-use requests (pending by default). */
export function listVaultPasswordManagerApprovals(
	target: ApiTarget,
	filter: { status?: VaultBrokerProposalStatus } = {}
): Promise<{ approvals: VaultBrokerProposal[] }> {
	return request(
		target,
		pmPath(`/approvals${query({ status: filter.status })}`),
		{},
		vaultPmApprovalsReply
	);
}

/** Approve (with a grant lifetime) or reject a credential-use request.
 *  Needs `admin` on the account. */
export function decideVaultPasswordManagerApproval(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject",
	input: VaultPasswordManagerDecisionInput = {}
): Promise<
	| { approved: true; grant: VaultPasswordManagerGrant; proposal: string }
	| { rejected: true }
> {
	const body: VaultPasswordManagerDecisionInput = {};
	if (input.note) {
		body.note = input.note;
	}
	if (decision === "approve" && input.grant) {
		body.grant = input.grant;
	}
	return request(
		target,
		pmPath(`/approvals/${encodeURIComponent(id)}/${decision}`),
		{ method: "POST", body },
		vaultPmDecisionReply
	);
}

/** Mint a broker session with a machine token; it lives no longer than the token. */
export function vaultAgentBrokerSession(
	target: VaultAgentTarget,
	input: VaultBrokerSessionInput
): Promise<VaultBrokerSessionGrant> {
	return agentRequest(
		vaultBrokerGrantReply,
		target,
		"/api/vault/agent/broker/sessions",
		{ method: "POST", body: input }
	);
}

/** Services and placeholders the token (or broker session) may use. Never values. */
export function vaultAgentBrokerDiscover(
	target: VaultAgentTarget,
	filter: { environment?: string } = {}
): Promise<VaultBrokerDiscovery> {
	return agentRequest(
		vaultBrokerDiscoveryReply,
		target,
		`/api/vault/agent/broker/discover${query({ environment: filter.environment })}`
	);
}

/** Propose services or credentials for a human to approve. */
export function vaultAgentBrokerPropose(
	target: VaultAgentTarget,
	input: {
		credentials?: Partial<VaultBrokerCredentialRequest>[];
		environment?: string;
		message?: string;
		services?: Record<string, AppJsonValue>[];
	}
): Promise<{ proposal: VaultBrokerProposal }> {
	return agentRequest(
		vaultBrokerProposalReply,
		target,
		"/api/vault/agent/broker/proposals",
		{ method: "POST", body: input }
	);
}

export function vaultAgentBrokerProposal(
	target: VaultAgentTarget,
	id: string
): Promise<{ proposal: VaultBrokerProposal }> {
	return agentRequest(
		vaultBrokerProposalReply,
		target,
		`/api/vault/agent/broker/proposals/${encodeURIComponent(id)}`
	);
}
