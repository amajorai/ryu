// packages/core-client/src/vault/seal.ts
//
// Seal, keys, migration: part of the Secret Vault client. `../vault.ts` re-
// exports these names and documents the wire conventions.

import { type ApiTarget, request } from "../client.ts";
import {
	vaultHumanMigration,
	vaultHumanRotateResponse,
	vaultHumanSealResponse,
	vaultHumanShamirResponse,
	vaultHumanStatus,
} from "./codecs-human.ts";
import type { VaultSealStatus } from "./shared.ts";

export interface VaultSysStatus {
	activeEnvironment: string;
	seal: VaultSealStatus;
	sharedRemote: boolean;
}

export function getVaultStatus(target: ApiTarget): Promise<VaultSysStatus> {
	return request(target, "/api/vault/sys/status", {}, vaultHumanStatus);
}

export function sealVault(
	target: ApiTarget
): Promise<{ seal: VaultSealStatus }> {
	return request(
		target,
		"/api/vault/sys/seal",
		{ method: "POST", body: {} },
		vaultHumanSealResponse
	);
}

/** Submit one Shamir key share, or (in `auto` mode) unseal with the master key. */
export function unsealVault(
	target: ApiTarget,
	share?: string
): Promise<{ seal: VaultSealStatus }> {
	return request(
		target,
		"/api/vault/sys/unseal",
		{
			method: "POST",
			body: share === undefined ? {} : { share },
		},
		vaultHumanSealResponse
	);
}

/** Switch to Shamir seal mode. The shares are returned exactly once. */
export function initVaultShamir(
	target: ApiTarget,
	input: { shares?: number; threshold?: number } = {}
): Promise<{ seal: VaultSealStatus; shares: string[] }> {
	return request(
		target,
		"/api/vault/sys/init-shamir",
		{
			method: "POST",
			body: input,
		},
		vaultHumanShamirResponse
	);
}

export function migrateVaultToAutoSeal(
	target: ApiTarget
): Promise<{ seal: VaultSealStatus }> {
	return request(
		target,
		"/api/vault/sys/migrate-auto",
		{
			method: "POST",
			body: {},
		},
		vaultHumanSealResponse
	);
}

/** Rotate the data-encryption key and rewrap every sealed row. */
export function rotateVaultKey(
	target: ApiTarget
): Promise<{ keyVersion: number; rewrapped: number; seal: VaultSealStatus }> {
	return request(
		target,
		"/api/vault/sys/rotate",
		{ method: "POST", body: {} },
		vaultHumanRotateResponse
	);
}

/** Move legacy node-local team/org values to the control plane. */
export function migrateVaultShared(target: ApiTarget): Promise<{
	failed: Array<{ error: string; key: string }>;
	moved: number;
	ok: boolean;
}> {
	return request(
		target,
		"/api/vault/migrate-shared",
		{ method: "POST" },
		vaultHumanMigration
	);
}
