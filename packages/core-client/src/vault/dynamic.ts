// packages/core-client/src/vault/dynamic.ts
//
// Dynamic secrets and leases: part of the Secret Vault client. `../vault.ts`
// re-exports these names and documents the wire conventions.

import type { AppJsonValue } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import { vaultHumanDeletedEngine } from "./codecs-human.ts";
import {
	vaultHumanDynamicRoleResponse,
	vaultHumanDynamicRoles,
	vaultHumanLeases,
	vaultHumanRevokedCount,
} from "./codecs-human-engines.ts";
import {
	vaultMachineDynamicResponse,
	vaultMachineLeaseResponse,
} from "./codecs-machine.ts";
import { query } from "./internal.ts";
import type { VaultCharset, VaultTimestamp } from "./shared.ts";

export type VaultDynamicProvider =
	| {
			connectionUrl: string;
			creationStatements: string[];
			kind: "postgres";
			revocationStatements?: string[];
			usernamePrefix?: string;
	  }
	| {
			accessKeyId: string;
			endpoint?: string;
			kind: "aws-sts";
			region: string;
			roleArn: string;
			secretAccessKey: string;
			sessionPolicy?: string;
	  }
	| { kind: "webhook"; signingSecret: string; url: string }
	| { charset: VaultCharset; field?: string; kind: "random"; length: number };

export interface VaultDynamicRole {
	createdAt: VaultTimestamp;
	defaultTtlSecs: number;
	maxTtlSecs: number;
	name: string;
	provider: string;
	/** Provider configuration with credentials redacted. */
	summary: AppJsonValue;
	updatedAt: VaultTimestamp;
}

export interface VaultLease {
	createdAt: VaultTimestamp;
	expiresAt: VaultTimestamp;
	id: string;
	issuedTo: string | null;
	maxExpiresAt: VaultTimestamp;
	provider: string;
	renewable: boolean;
	revokedAt: VaultTimestamp | null;
	role: string;
}

export interface VaultDynamicCredential {
	/** The credential, returned once. */
	data: Record<string, string>;
	lease: VaultLease;
}

export function listVaultDynamicRoles(
	target: ApiTarget
): Promise<{ roles: VaultDynamicRole[] }> {
	return request(
		target,
		"/api/vault/dynamic/roles",
		{},
		vaultHumanDynamicRoles
	);
}

export function putVaultDynamicRole(
	target: ApiTarget,
	name: string,
	input: {
		defaultTtlSecs?: number;
		maxTtlSecs?: number;
		provider: VaultDynamicProvider;
	}
): Promise<{ role: VaultDynamicRole }> {
	return request(
		target,
		`/api/vault/dynamic/roles/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			body: input,
		},
		vaultHumanDynamicRoleResponse
	);
}

export function deleteVaultDynamicRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/dynamic/roles/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

export function revokeAllVaultDynamicLeases(
	target: ApiTarget,
	name: string
): Promise<{ revoked: number }> {
	return request(
		target,
		`/api/vault/dynamic/roles/${encodeURIComponent(name)}/revoke-all`,
		{ method: "POST" },
		vaultHumanRevokedCount
	);
}

export function issueVaultDynamicCredential(
	target: ApiTarget,
	role: string,
	ttlSecs?: number
): Promise<{ credential: VaultDynamicCredential }> {
	return request(
		target,
		`/api/vault/dynamic/issue/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: ttlSecs === undefined ? {} : { ttlSecs },
		},
		vaultMachineDynamicResponse
	);
}

export function listVaultLeases(
	target: ApiTarget,
	filter: { includeRevoked?: boolean; role?: string } = {}
): Promise<{ leases: VaultLease[] }> {
	return request(
		target,
		`/api/vault/leases${query({ role: filter.role, includeRevoked: filter.includeRevoked })}`,
		{},
		vaultHumanLeases
	);
}

export function vaultLease(
	target: ApiTarget,
	id: string,
	op: "renew" | "revoke",
	ttlSecs?: number
): Promise<{ lease: VaultLease }> {
	return request(
		target,
		`/api/vault/leases/${encodeURIComponent(id)}/${op}`,
		{
			method: "POST",
			body: ttlSecs === undefined ? {} : { ttlSecs },
		},
		vaultMachineLeaseResponse
	);
}
