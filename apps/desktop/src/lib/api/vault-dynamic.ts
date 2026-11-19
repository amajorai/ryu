// Dynamic secrets and leases (`/api/vault/dynamic/*`, `/api/vault/leases`).
// Role listings carry a redacted provider summary; an issued credential is
// returned once, by the issue call only, and is never stored by Desktop.

import type {
	VaultDynamicCredential,
	VaultDynamicProvider,
	VaultDynamicRole,
	VaultLease,
} from "@ryuhq/core-client/vault.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { vaultQueryString } from "./vault-query.ts";

export type {
	VaultDynamicCredential,
	VaultDynamicProvider,
	VaultDynamicRole,
	VaultLease,
} from "@ryuhq/core-client/vault.ts";

const timestamp = z.union([z.string(), z.number()]);
const id = (value: string) => encodeURIComponent(value);

const roleSchema = z
	.object({
		createdAt: timestamp,
		defaultTtlSecs: z.number(),
		maxTtlSecs: z.number(),
		name: z.string(),
		provider: z.string(),
		summary: z.unknown(),
		updatedAt: timestamp,
	})
	.passthrough();

const leaseSchema = z
	.object({
		createdAt: timestamp,
		expiresAt: timestamp,
		id: z.string(),
		issuedTo: z.string().nullable(),
		maxExpiresAt: timestamp,
		provider: z.string(),
		renewable: z.boolean(),
		revokedAt: timestamp.nullable(),
		role: z.string(),
	})
	.passthrough();

const rolesReply = z.object({ roles: z.array(roleSchema) });
const roleReply = z.object({ role: roleSchema });
const leasesReply = z.object({ leases: z.array(leaseSchema) });
const leaseReply = z.object({ lease: leaseSchema });
const deletedReply = z.object({ deleted: z.boolean() });
const revokedReply = z.object({ revoked: z.number() });
const credentialReply = z.object({
	credential: z.object({
		data: z.record(z.string(), z.string()),
		lease: leaseSchema,
	}),
});

export async function listVaultDynamicRoles(
	target: ApiTarget
): Promise<VaultDynamicRole[]> {
	const raw = await request(
		target,
		"/api/vault/dynamic/roles",
		undefined,
		rolesReply
	);
	return raw.roles as VaultDynamicRole[];
}

export async function putVaultDynamicRole(
	target: ApiTarget,
	name: string,
	input: {
		defaultTtlSecs?: number;
		maxTtlSecs?: number;
		provider: VaultDynamicProvider;
	}
): Promise<VaultDynamicRole> {
	const raw = await request(
		target,
		`/api/vault/dynamic/roles/${id(name)}`,
		{ method: "PUT", body: input },
		roleReply
	);
	return raw.role as VaultDynamicRole;
}

export async function deleteVaultDynamicRole(
	target: ApiTarget,
	name: string
): Promise<boolean> {
	const raw = await request(
		target,
		`/api/vault/dynamic/roles/${id(name)}`,
		{ method: "DELETE" },
		deletedReply
	);
	return raw.deleted;
}

/** Revoke every live lease of a role; resolves to how many were revoked. */
export async function revokeAllVaultDynamicLeases(
	target: ApiTarget,
	name: string
): Promise<number> {
	const raw = await request(
		target,
		`/api/vault/dynamic/roles/${id(name)}/revoke-all`,
		{ method: "POST" },
		revokedReply
	);
	return raw.revoked;
}

/** Issue a credential. Its `data` is returned once and never again. */
export async function issueVaultDynamicCredential(
	target: ApiTarget,
	role: string,
	ttlSecs?: number
): Promise<VaultDynamicCredential> {
	const raw = await request(
		target,
		`/api/vault/dynamic/issue/${id(role)}`,
		{ method: "POST", body: ttlSecs === undefined ? {} : { ttlSecs } },
		credentialReply
	);
	return raw.credential as VaultDynamicCredential;
}

export async function listVaultLeases(
	target: ApiTarget,
	filter: { includeRevoked?: boolean; role?: string } = {}
): Promise<VaultLease[]> {
	const raw = await request(
		target,
		`/api/vault/leases${vaultQueryString({
			role: filter.role,
			includeRevoked: filter.includeRevoked ? "true" : undefined,
		})}`,
		undefined,
		leasesReply
	);
	return raw.leases as VaultLease[];
}

export async function changeVaultLease(
	target: ApiTarget,
	leaseId: string,
	op: "renew" | "revoke",
	ttlSecs?: number
): Promise<VaultLease> {
	const raw = await request(
		target,
		`/api/vault/leases/${id(leaseId)}/${op}`,
		{ method: "POST", body: ttlSecs === undefined ? {} : { ttlSecs } },
		leaseReply
	);
	return raw.lease as VaultLease;
}
