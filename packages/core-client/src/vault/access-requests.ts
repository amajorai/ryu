// packages/core-client/src/vault/access-requests.ts
//
// Access requests (roadmap P1-9): time-bound, approval-gated access to a path
// on this node. Part of the Secret Vault client; `../vault.ts` re-exports these
// names and documents the wire conventions.
//
// Core renders every `…At` field as RFC 3339 and leaves optional fields out
// (never `null`). Team, organization and project requests live on the control
// plane and are not reachable through these Core routes.

import { z } from "zod";
import { type ApiTarget, request } from "../client.ts";
import { vaultMachineCodec } from "./codecs-machine.ts";
import {
	vaultHumanCapabilities,
	vaultHumanNumber,
	vaultHumanText,
	vaultHumanTimestamp,
} from "./codecs-reply.ts";
import type { VaultCapability, VaultTimestamp } from "./shared.ts";

export type VaultAccessRequestStatus =
	| "pending"
	| "granted"
	| "denied"
	| "cancelled"
	| "revoked"
	| "expired";

export type VaultAccessRequestDecision =
	| "approve"
	| "deny"
	| "cancel"
	| "revoke";

/** One approval step: who may approve and how many distinct approvals. */
export interface VaultAccessStep {
	approvals: number;
	/** `user:<id>`, `team:<id>`, `role:<name>`, or `machine:<id>`. */
	approvers: string[];
	name: string;
}

export interface VaultAccessApproval {
	approvedAt: VaultTimestamp;
	approver: string;
	/** The `policy/step` name this approval counts toward. */
	factor: string;
}

export interface VaultAccessRequest {
	approvals: VaultAccessApproval[];
	capabilities: VaultCapability[];
	createdAt: VaultTimestamp;
	/** The step waiting for approvals (pending requests only). */
	currentStep?: string;
	decidedAt?: VaultTimestamp;
	decidedBy?: string;
	decisionReason?: string;
	durationSecs: number;
	environment: string;
	/** When a pending request lapses. */
	expiresAt: VaultTimestamp;
	grantExpiresAt?: VaultTimestamp;
	grantedAt?: VaultTimestamp;
	grantPolicy?: string;
	id: string;
	/** Glob over `ENV/folder/NAME`; the first segment is the environment. */
	path: string;
	policies: string[];
	reason: string;
	/** `user:<id>` of the requester. */
	requester: string;
	status: VaultAccessRequestStatus;
	steps: VaultAccessStep[];
}

export interface VaultAccessPolicy {
	capabilities: VaultCapability[];
	description: string;
	maxDurationSecs: number;
	name: string;
	path: string;
	requestTtlSecs?: number;
	steps: VaultAccessStep[];
}

export interface CreateVaultAccessRequestInput {
	capabilities: VaultCapability[];
	durationSecs: number;
	/** Glob over `ENV/folder/NAME`, for example `prod/payments/**`. */
	path: string;
	reason: string;
}

const accessStep = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		approvers: z.array(vaultHumanText),
		approvals: vaultHumanNumber,
	})
);

const accessApproval = vaultMachineCodec(
	z.object({
		factor: vaultHumanText,
		approver: vaultHumanText,
		approvedAt: vaultHumanTimestamp,
	})
);

const accessRequest = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		requester: vaultHumanText,
		environment: vaultHumanText,
		path: vaultHumanText,
		capabilities: vaultHumanCapabilities,
		durationSecs: vaultHumanNumber,
		reason: vaultHumanText,
		policies: z.array(vaultHumanText),
		steps: z.array(accessStep),
		approvals: z.array(accessApproval),
		status: z.enum([
			"pending",
			"granted",
			"denied",
			"cancelled",
			"revoked",
			"expired",
		]),
		currentStep: vaultHumanText.optional(),
		createdAt: vaultHumanTimestamp,
		expiresAt: vaultHumanTimestamp,
		decidedAt: vaultHumanTimestamp.optional(),
		decidedBy: vaultHumanText.optional(),
		decisionReason: vaultHumanText.optional(),
		grantPolicy: vaultHumanText.optional(),
		grantedAt: vaultHumanTimestamp.optional(),
		grantExpiresAt: vaultHumanTimestamp.optional(),
	})
);

const accessPolicy = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		description: vaultHumanText,
		path: vaultHumanText,
		capabilities: vaultHumanCapabilities,
		maxDurationSecs: vaultHumanNumber,
		requestTtlSecs: vaultHumanNumber.optional(),
		steps: z.array(accessStep),
	})
);

const accessRequestList = vaultMachineCodec(
	z.object({ accessRequests: z.array(accessRequest) })
);

const accessRequestOne = vaultMachineCodec(z.object({ accessRequest }));

const accessRequestWrite = vaultMachineCodec(
	z.object({ ok: z.boolean(), accessRequest })
);

const accessPolicyList = vaultMachineCodec(
	z.object({ accessPolicies: z.array(accessPolicy) })
);

function requestPath(id: string, action?: VaultAccessRequestDecision): string {
	const base = `/api/vault/access-requests/${encodeURIComponent(id)}`;
	return action ? `${base}/${action}` : base;
}

/** Requests the caller opened or may approve (an admin sees all). */
export function listVaultAccessRequests(
	target: ApiTarget
): Promise<{ accessRequests: VaultAccessRequest[] }> {
	return request(target, "/api/vault/access-requests", {}, accessRequestList);
}

export function getVaultAccessRequest(
	target: ApiTarget,
	id: string
): Promise<{ accessRequest: VaultAccessRequest }> {
	return request(target, requestPath(id), {}, accessRequestOne);
}

/** Open a request. Core answers 201 with the pending request. */
export function createVaultAccessRequest(
	target: ApiTarget,
	input: CreateVaultAccessRequestInput
): Promise<{ accessRequest: VaultAccessRequest; ok: boolean }> {
	return request(
		target,
		"/api/vault/access-requests",
		{ method: "POST", body: input },
		accessRequestWrite
	);
}

/** Approve or deny the open step (approvers), cancel (the requester), or
 *  revoke an active grant (the requester or an admin). */
export function decideVaultAccessRequest(
	target: ApiTarget,
	id: string,
	decision: VaultAccessRequestDecision,
	reason?: string
): Promise<{ accessRequest: VaultAccessRequest; ok: boolean }> {
	return request(
		target,
		requestPath(id, decision),
		{ method: "POST", body: reason === undefined ? {} : { reason } },
		accessRequestWrite
	);
}

/** Every access policy, so a requester can see who approves what. */
export function listVaultAccessPolicies(
	target: ApiTarget
): Promise<{ accessPolicies: VaultAccessPolicy[] }> {
	return request(target, "/api/vault/access-policies", {}, accessPolicyList);
}
