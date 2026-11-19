// packages/core-client/src/vault/control-groups.ts
//
// Control groups (`/api/vault/control-groups`) and the caller's capabilities
// (`/api/vault/capabilities-self`): part of the Secret Vault client.
// `../vault.ts` re-exports these names and documents the wire conventions.
//
// A policy rule with a `controlGroup` makes a reveal answer `202` with a
// pending request and a single-use `vcg_…` token instead of the value. Named
// approvers authorize it; the requester then redeems the token for the value
// pinned at request time. Shapes follow
// `apps/core/src/vault/policy_ext/control_groups.rs` as rendered by
// `server/vault_policy_ext_api/mod.rs`. Listings never carry tokens or values.

import { z } from "zod";
import { type AppJsonValue, appJsonValueSchema } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import {
	vaultDate,
	vaultNumber,
	vaultReply,
	vaultText,
} from "./codecs-machine.ts";
import { query, secretPath } from "./internal.ts";
import type { VaultCapability, VaultCoords, VaultTimestamp } from "./shared.ts";

export type VaultControlGroupStatus =
	| "pending"
	| "approved"
	| "redeemed"
	| "expired";

export interface VaultControlGroupFactor {
	/** Distinct approvals required. */
	approvals: number;
	/** Subjects (`user:`, `team:`, `role:`, `machine:`) allowed to approve. */
	approvers: string[];
	name: string;
}

export interface VaultControlGroupApproval {
	approvedAt: VaultTimestamp;
	approver: string;
	factor: string;
}

export interface VaultControlGroup {
	approvals: VaultControlGroupApproval[];
	createdAt: VaultTimestamp;
	expiresAt: VaultTimestamp;
	factors: VaultControlGroupFactor[];
	id: string;
	/** The `ENV/folder/NAME` policy key being read. */
	policyKey: string;
	redeemedAt?: VaultTimestamp;
	/** Subject of the requester (`user:<id>`). */
	requester: string;
	status: VaultControlGroupStatus;
	/** What the token releases: `{coords, version}` for a value reveal. */
	target: AppJsonValue;
}

export interface VaultCapabilitiesForPath {
	capabilities: VaultCapability[];
	/** Whether a control group gates `read` for this caller. */
	controlGroup: boolean;
}

/** A reveal either returns the value or opens a control-group request. */
export type VaultGatedReveal =
	| { status: "revealed"; value: string }
	| {
			controlGroup: VaultControlGroup;
			status: "control_group";
			/** The single-use `vcg_…` redemption token, for the requester only. */
			token: string;
	  };

const groupFields = z.object({
	id: vaultText,
	requester: vaultText,
	policyKey: vaultText,
	target: appJsonValueSchema,
	factors: z.array(
		z.object({
			name: vaultText,
			approvers: z.array(vaultText),
			approvals: vaultNumber,
		})
	),
	approvals: z.array(
		z.object({ factor: vaultText, approver: vaultText, approvedAt: vaultDate })
	),
	status: z.enum(["pending", "approved", "redeemed", "expired"]),
	createdAt: vaultDate,
	expiresAt: vaultDate,
	redeemedAt: vaultDate.optional(),
});

const listReply = vaultReply<{ controlGroups: VaultControlGroup[] }>(
	z.object({ controlGroups: z.array(groupFields) })
);
const oneReply = vaultReply<{ controlGroup: VaultControlGroup }>(
	z.object({ controlGroup: groupFields })
);
const redeemReply = vaultReply<{
	controlGroup: VaultControlGroup;
	value: string;
}>(z.object({ value: vaultText, controlGroup: groupFields }));
const openedFields = z.object({ controlGroup: groupFields, token: vaultText });
const revealFields = z.union([z.object({ value: vaultText }), openedFields]);
const revealReply = vaultReply<
	{ value: string } | { controlGroup: VaultControlGroup; token: string }
>(revealFields);
const capabilitiesReply = vaultReply<{
	paths: Record<string, VaultCapabilitiesForPath>;
}>(
	z.object({
		paths: z.record(
			z.string(),
			z.object({
				capabilities: z.array(vaultText),
				controlGroup: z.boolean(),
			})
		),
	})
);

function groupPath(id: string, suffix = ""): string {
	return `/api/vault/control-groups/${encodeURIComponent(id)}${suffix}`;
}

/** Requests the caller opened or may approve (`admin` on `sys/control-groups` sees all). */
export function listVaultControlGroups(
	target: ApiTarget
): Promise<{ controlGroups: VaultControlGroup[] }> {
	return request(target, "/api/vault/control-groups", {}, listReply);
}

export function getVaultControlGroup(
	target: ApiTarget,
	id: string
): Promise<{ controlGroup: VaultControlGroup }> {
	return request(target, groupPath(id), {}, oneReply);
}

/** Approve as the signed-in user; Core records the factors the caller satisfies. */
export function authorizeVaultControlGroup(
	target: ApiTarget,
	id: string
): Promise<{ controlGroup: VaultControlGroup }> {
	return request(
		target,
		groupPath(id, "/authorize"),
		{ method: "POST" },
		oneReply
	);
}

/** Redeem an approved request's token for the value (single use, requester only). */
export function redeemVaultControlGroup(
	target: ApiTarget,
	id: string,
	token: string
): Promise<{ controlGroup: VaultControlGroup; value: string }> {
	return request(
		target,
		groupPath(id, "/redeem"),
		{ method: "POST", body: { token } },
		redeemReply
	);
}

/**
 * Reveal a value that a control group may gate: the value, or the pending
 * request and its redemption token (Core answers `202`).
 */
export async function revealVaultSecretGated(
	target: ApiTarget,
	name: string,
	coords: VaultCoords & { version?: number }
): Promise<VaultGatedReveal> {
	const reply = await request(
		target,
		secretPath(name, "/reveal"),
		{ method: "POST", body: coords },
		revealReply
	);
	return "value" in reply
		? { status: "revealed", value: reply.value }
		: {
				status: "control_group",
				controlGroup: reply.controlGroup,
				token: reply.token,
			};
}

/** The caller's capabilities on policy keys (`ENV/folder/NAME`, `sys/…`). */
export function getVaultCapabilitiesSelf(
	target: ApiTarget,
	paths: readonly string[]
): Promise<{ paths: Record<string, VaultCapabilitiesForPath> }> {
	return request(
		target,
		`/api/vault/capabilities-self${query({ paths: paths.join(",") })}`,
		{},
		capabilitiesReply
	);
}
