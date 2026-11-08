// Audit-log and seal calls of the Core vault surface. Audit rows carry
// metadata only; unseal sends a key share and never echoes it back.

import type {
	VaultAuditQuery,
	VaultAuditVerifyReport,
	VaultSealStatus,
	VaultSysStatus,
} from "@ryuhq/core-client/vault.ts";
import { type ApiTarget, request } from "./client.ts";
import { vaultQueryString } from "./vault-query.ts";
import {
	listVaultAuditResponseSchema,
	sealVaultResponseSchema,
	unsealVaultResponseSchema,
	vaultSysStatusResponseSchema,
	verifyVaultAuditResponseSchema,
} from "./vault-schemas.ts";
import type { VaultAuditPage } from "./vault-types.ts";

export async function listVaultAudit(
	target: ApiTarget,
	query: VaultAuditQuery = {}
): Promise<VaultAuditPage> {
	const raw = await request(
		target,
		`/api/vault/audit${vaultQueryString({
			before: query.before,
			limit: query.limit,
			name: query.name,
			action: query.action,
			actorId: query.actorId,
			environment: query.environment,
		})}`,
		undefined,
		listVaultAuditResponseSchema
	);
	return { events: raw?.events ?? [], nextBefore: raw?.nextBefore ?? null };
}

export async function verifyVaultAudit(
	target: ApiTarget
): Promise<VaultAuditVerifyReport> {
	const raw = await request(
		target,
		"/api/vault/audit/verify",
		undefined,
		verifyVaultAuditResponseSchema
	);
	return raw.report;
}

export async function getVaultSysStatus(
	target: ApiTarget
): Promise<VaultSysStatus> {
	return await request(
		target,
		"/api/vault/sys/status",
		undefined,
		vaultSysStatusResponseSchema
	);
}

export async function sealVault(target: ApiTarget): Promise<VaultSealStatus> {
	const raw = await request(
		target,
		"/api/vault/sys/seal",
		{ body: {}, method: "POST" },
		sealVaultResponseSchema
	);
	return raw.seal;
}

/** Submit one key share (Shamir mode) or unseal with the master key (auto mode). */
export async function unsealVault(
	target: ApiTarget,
	share?: string
): Promise<VaultSealStatus> {
	const raw = await request(
		target,
		"/api/vault/sys/unseal",
		{ body: share ? { share } : {}, method: "POST" },
		unsealVaultResponseSchema
	);
	return raw.seal;
}
