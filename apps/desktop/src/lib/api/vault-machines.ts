// Machine identities (`/api/vault/machines`), their AppRole secret ids, and
// the machine tokens minted for them (`/api/vault/tokens`). Every route needs
// the vault `admin` capability on `sys/machines`.
//
// A secret id and a token are returned exactly once, by `issueVaultSecretId`
// and `issueVaultMachineToken`. Callers keep them out of any shared cache
// (React Query included) and drop them when the dialog showing them closes.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const timestamp = z.union([z.string(), z.number()]);

const machineSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		auth: z
			.object({ kind: z.string(), role_id: z.string().optional() })
			.passthrough(),
		policies: z.array(z.string()),
		tokenTtlSecs: z.number(),
		disabled: z.boolean(),
		createdAt: timestamp,
		createdBy: z.string().nullable(),
	})
	.passthrough();

const secretIdSchema = z.object({
	accessor: z.string(),
	createdAt: timestamp,
	expiresAt: timestamp.nullable(),
	usesRemaining: z.number().nullable(),
});

const tokenSchema = z
	.object({
		accessor: z.string(),
		identityId: z.string(),
		policies: z.array(z.string()),
		role: z.string().nullable(),
		createdAt: timestamp,
		expiresAt: timestamp,
		numUsesRemaining: z.number().nullable(),
		revokedAt: timestamp.nullable(),
	})
	.passthrough();

const issuedTokenSchema = z.object({
	token: z.string(),
	accessor: z.string(),
	identityId: z.string(),
	policies: z.array(z.string()),
	expiresAt: timestamp,
});

export type VaultMachine = z.infer<typeof machineSchema>;
export type VaultMachineSecretId = z.infer<typeof secretIdSchema>;
export type VaultMachineToken = z.infer<typeof tokenSchema>;
export type VaultIssuedMachineToken = z.infer<typeof issuedTokenSchema>;

export interface VaultAppRoleInput {
	name: string;
	policies: string[];
	tokenTtlSecs?: number;
}

export interface VaultSecretIdInput {
	cidrList?: string[];
	tokenBoundCidrs?: string[];
	ttlSecs?: number;
	uses?: number;
}

export interface VaultMachineTokenInput {
	numUses?: number;
	role?: string;
	ttlSecs?: number;
}

const machineReply = z.object({ machine: machineSchema });
const machinesReply = z.object({ machines: z.array(machineSchema) });
const deletedReply = z.object({ deleted: z.boolean() });
const revokedReply = z.object({ revoked: z.boolean() });

const machinePath = (id: string, suffix = "") =>
	`/api/vault/machines/${encodeURIComponent(id)}${suffix}`;

export async function listVaultMachines(
	target: ApiTarget
): Promise<VaultMachine[]> {
	const raw = await request(
		target,
		"/api/vault/machines",
		undefined,
		machinesReply
	);
	return raw.machines;
}

/** Create an AppRole identity. Core generates its role id. */
export async function createVaultAppRole(
	target: ApiTarget,
	input: VaultAppRoleInput
): Promise<VaultMachine> {
	const raw = await request(
		target,
		"/api/vault/machines",
		{ method: "POST", body: { ...input, auth: { kind: "approle" } } },
		machineReply
	);
	return raw.machine;
}

/** Disabling an identity revokes its live tokens in Core. */
export async function setVaultMachineDisabled(
	target: ApiTarget,
	id: string,
	disabled: boolean
): Promise<VaultMachine> {
	const raw = await request(
		target,
		machinePath(id),
		{ method: "PATCH", body: { disabled } },
		machineReply
	);
	return raw.machine;
}

export async function deleteVaultMachine(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const raw = await request(
		target,
		machinePath(id),
		{ method: "DELETE" },
		deletedReply
	);
	return raw.deleted;
}

export async function listVaultSecretIds(
	target: ApiTarget,
	machineId: string
): Promise<VaultMachineSecretId[]> {
	const raw = await request(
		target,
		machinePath(machineId, "/secret-ids"),
		undefined,
		z.object({ secretIds: z.array(secretIdSchema) })
	);
	return raw.secretIds;
}

/** Issue an AppRole secret id; the value is returned exactly once. */
export function issueVaultSecretId(
	target: ApiTarget,
	machineId: string,
	input: VaultSecretIdInput
): Promise<{ info: VaultMachineSecretId; secretId: string }> {
	return request(
		target,
		machinePath(machineId, "/secret-ids"),
		{ method: "POST", body: input },
		z.object({ secretId: z.string(), info: secretIdSchema })
	);
}

export async function revokeVaultSecretId(
	target: ApiTarget,
	accessor: string
): Promise<boolean> {
	const raw = await request(
		target,
		`/api/vault/secret-ids/${encodeURIComponent(accessor)}`,
		{ method: "DELETE" },
		revokedReply
	);
	return raw.revoked;
}

/** Live tokens of one identity (metadata only, never a token). */
export async function listVaultMachineTokens(
	target: ApiTarget,
	identity: string
): Promise<VaultMachineToken[]> {
	const raw = await request(
		target,
		`/api/vault/tokens?identity=${encodeURIComponent(identity)}`,
		undefined,
		z.object({ tokens: z.array(tokenSchema) })
	);
	return raw.tokens;
}

/** Mint a token for an identity; the `rvt_…` token is returned exactly once. */
export async function issueVaultMachineToken(
	target: ApiTarget,
	identity: string,
	input: VaultMachineTokenInput
): Promise<VaultIssuedMachineToken> {
	const raw = await request(
		target,
		"/api/vault/tokens",
		{ method: "POST", body: { ...input, identity } },
		z.object({ token: issuedTokenSchema })
	);
	return raw.token;
}

export async function revokeVaultMachineToken(
	target: ApiTarget,
	accessor: string
): Promise<boolean> {
	const raw = await request(
		target,
		`/api/vault/tokens/${encodeURIComponent(accessor)}/revoke`,
		{ method: "POST" },
		revokedReply
	);
	return raw.revoked;
}
