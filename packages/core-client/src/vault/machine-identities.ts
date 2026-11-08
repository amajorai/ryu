// packages/core-client/src/vault/machine-identities.ts
//
// Machine identities: part of the Secret Vault client. `../vault.ts` re-exports
// these names and documents the wire conventions.

import type { z } from "zod";
import { type ApiTarget, request } from "../client.ts";
import { vaultHumanDeletedEngine } from "./codecs-human.ts";
import {
	vaultHumanIssuedSecretId,
	type vaultHumanMachineAuth,
	vaultHumanMachineResponse,
	vaultHumanMachines,
	vaultHumanSecretIds,
} from "./codecs-human-engines.ts";
import { vaultMachineRevokedResponse } from "./codecs-machine.ts";
import type { VaultTimestamp } from "./shared.ts";

export interface VaultJwtConfig {
	audiences?: string[];
	/** Claim → allowed values (policy glob grammar). */
	boundClaims?: Record<string, string[]>;
	issuer: string;
	jwksUrl?: string;
	publicKeyPem?: string;
}

export type VaultMachineAuth =
	| { kind: "approle"; roleId: string }
	| ({ kind: "jwt" } & VaultJwtConfig);

export type VaultMachineAuthResponse = z.output<typeof vaultHumanMachineAuth>;

export interface VaultMachineIdentity {
	auth: VaultMachineAuthResponse;
	createdAt: VaultTimestamp;
	createdBy: string | null;
	disabled: boolean;
	id: string;
	name: string;
	policies: string[];
	tokenTtlSecs: number;
}

export interface VaultSecretIdInfo {
	accessor: string;
	createdAt: VaultTimestamp;
	expiresAt: VaultTimestamp | null;
	usesRemaining: number | null;
}

export function listVaultMachines(
	target: ApiTarget
): Promise<{ machines: VaultMachineIdentity[] }> {
	return request(target, "/api/vault/machines", {}, vaultHumanMachines);
}

export function createVaultMachine(
	target: ApiTarget,
	input: {
		auth: VaultMachineAuth;
		name: string;
		policies?: string[];
		tokenTtlSecs?: number;
	}
): Promise<{ machine: VaultMachineIdentity }> {
	return request(
		target,
		"/api/vault/machines",
		{
			method: "POST",
			body: input,
		},
		vaultHumanMachineResponse
	);
}

export function updateVaultMachine(
	target: ApiTarget,
	id: string,
	patch: { disabled?: boolean; policies?: string[]; tokenTtlSecs?: number }
): Promise<{ machine: VaultMachineIdentity }> {
	return request(
		target,
		`/api/vault/machines/${encodeURIComponent(id)}`,
		{
			method: "PATCH",
			body: patch,
		},
		vaultHumanMachineResponse
	);
}

export function deleteVaultMachine(
	target: ApiTarget,
	id: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/machines/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

export function listVaultSecretIds(
	target: ApiTarget,
	machineId: string
): Promise<{ secretIds: VaultSecretIdInfo[] }> {
	return request(
		target,
		`/api/vault/machines/${encodeURIComponent(machineId)}/secret-ids`,
		{},
		vaultHumanSecretIds
	);
}

/** Issue an AppRole secret id. The value is returned exactly once. */
export function issueVaultSecretId(
	target: ApiTarget,
	machineId: string,
	input: { ttlSecs?: number; uses?: number } = {}
): Promise<{ info: VaultSecretIdInfo; secretId: string }> {
	return request(
		target,
		`/api/vault/machines/${encodeURIComponent(machineId)}/secret-ids`,
		{ method: "POST", body: input },
		vaultHumanIssuedSecretId
	);
}

export function revokeVaultSecretId(
	target: ApiTarget,
	accessor: string
): Promise<{ revoked: boolean }> {
	return request(
		target,
		`/api/vault/secret-ids/${encodeURIComponent(accessor)}`,
		{
			method: "DELETE",
		},
		vaultMachineRevokedResponse
	);
}

export function revokeVaultToken(
	target: ApiTarget,
	accessor: string
): Promise<{ revoked: boolean }> {
	return request(
		target,
		`/api/vault/tokens/${encodeURIComponent(accessor)}/revoke`,
		{ method: "POST" },
		vaultMachineRevokedResponse
	);
}
