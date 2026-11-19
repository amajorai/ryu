// Dynamic-credential leases held by `ryu secrets agent`.
//
// Each configured lease is issued once at start and renewed before it expires.
// When a renewal no longer extends it (the lease reached its maximum lifetime),
// is refused, or Core reports the lease revoked or expired, the agent issues a
// fresh credential and renders the templates again. The replaced lease is not
// revoked: a consumer may still hold a connection on it, and it ends on its
// own at its expiry. Leases still held when the agent stops are revoked unless
// the config sets `revokeLeasesOnExit` to false.

import { ApiError } from "@ryuhq/core-client/client";
import {
	type VaultAgentTarget,
	vaultAgentDynamicIssue,
	vaultAgentLease,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { refusedByCore } from "./secrets-agentd-auth.ts";
import type { AgentLeaseConfig } from "./secrets-agentd-config.ts";
import { timestampMs } from "./secrets-agentd-schedule.ts";

export interface HeldLease {
	config: AgentLeaseConfig;
	data: Record<string, string>;
	expiresAtMs: number | null;
	id: string;
	renewable: boolean;
}

export async function issueLease(
	target: VaultAgentTarget,
	config: AgentLeaseConfig
): Promise<HeldLease> {
	const { credential } = await vaultAgentDynamicIssue(
		target,
		config.role,
		config.ttlSecs
	);
	return {
		config,
		data: credential.data,
		id: credential.lease.id,
		expiresAtMs: timestampMs(credential.lease.expiresAt),
		renewable: credential.lease.renewable,
	};
}

/** Renew `held`. Resolves the renewed lease, or null when it must be replaced
 *  by a fresh credential. An outage is thrown, so the caller retries. */
export async function renewLease(
	target: VaultAgentTarget,
	held: HeldLease
): Promise<HeldLease | null> {
	if (!held.renewable) {
		return null;
	}
	try {
		const { lease } = await vaultAgentLease(
			target,
			held.id,
			"renew",
			held.config.ttlSecs
		);
		const expiresAtMs = timestampMs(lease.expiresAt);
		if (
			lease.revokedAt !== null ||
			expiresAtMs === null ||
			(held.expiresAtMs !== null && expiresAtMs <= held.expiresAtMs)
		) {
			return null;
		}
		return { ...held, expiresAtMs, renewable: lease.renewable };
	} catch (error) {
		// Refused, unknown to Core (404) or not renewable (400): replace it.
		if (
			refusedByCore(error) ||
			(error instanceof ApiError &&
				(error.status === 404 || error.status === 400))
		) {
			return null;
		}
		throw error;
	}
}

/** Revoke every lease, reporting (never throwing) the ones that fail. */
export async function revokeLeases(
	target: VaultAgentTarget,
	leases: Iterable<HeldLease>,
	err: (text: string) => void
): Promise<void> {
	for (const held of leases) {
		try {
			await vaultAgentLease(target, held.id, "revoke");
		} catch {
			err(
				`${tf("Could not revoke lease {id}; it expires at {expiresAt}.", { id: held.id, expiresAt: String(held.expiresAtMs ?? "?") })}\n`
			);
		}
	}
}
