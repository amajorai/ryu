// packages/core-client/src/vault/environments.ts
//
// Environments, folders, imports: part of the Secret Vault client.
// `../vault.ts` re-exports these names and documents the wire conventions.

import { type ApiTarget, request } from "../client.ts";
import {
	vaultHumanAddedImport,
	vaultHumanCreatedFolder,
	vaultHumanDeleted,
	vaultHumanEnvironments,
	vaultHumanFolders,
	vaultHumanImports,
	vaultHumanPutEnvironment,
	vaultHumanRemoved,
} from "./codecs-human.ts";
import { query } from "./internal.ts";

export interface VaultEnvironment {
	name: string;
	position: number;
	protected: boolean;
	requiredApprovals: number;
	slug: string;
}

export function listVaultEnvironments(
	target: ApiTarget
): Promise<{ active: string; environments: VaultEnvironment[] }> {
	return request(target, "/api/vault/environments", {}, vaultHumanEnvironments);
}

export function putVaultEnvironment(
	target: ApiTarget,
	slug: string,
	input: Partial<Omit<VaultEnvironment, "slug">> = {}
): Promise<{ environment: VaultEnvironment; ok: boolean }> {
	return request(
		target,
		`/api/vault/environments/${encodeURIComponent(slug)}`,
		{
			method: "PUT",
			body: input,
		},
		vaultHumanPutEnvironment
	);
}

export function deleteVaultEnvironment(
	target: ApiTarget,
	slug: string
): Promise<{ deleted: boolean; ok: boolean }> {
	return request(
		target,
		`/api/vault/environments/${encodeURIComponent(slug)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeleted
	);
}

export function listVaultFolders(
	target: ApiTarget,
	environment: string
): Promise<{ folders: string[] }> {
	return request(
		target,
		`/api/vault/folders${query({ environment })}`,
		{},
		vaultHumanFolders
	);
}

export function createVaultFolder(
	target: ApiTarget,
	input: { environment: string; path: string }
): Promise<{ ok: boolean; path: string }> {
	return request(
		target,
		"/api/vault/folders",
		{ method: "POST", body: input },
		vaultHumanCreatedFolder
	);
}

export function deleteVaultFolder(
	target: ApiTarget,
	input: { environment: string; path: string }
): Promise<{ deleted: boolean; ok: boolean }> {
	return request(
		target,
		`/api/vault/folders${query(input)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeleted
	);
}

export interface VaultFolderImport {
	environment: string;
	id: string;
	path: string;
	position: number;
	sourceEnvironment: string;
	sourcePath: string;
}

export function listVaultImports(
	target: ApiTarget
): Promise<{ imports: VaultFolderImport[] }> {
	return request(target, "/api/vault/imports", {}, vaultHumanImports);
}

export function addVaultImport(
	target: ApiTarget,
	input: Omit<VaultFolderImport, "id" | "position"> & { position?: number }
): Promise<{ import: VaultFolderImport; ok: boolean }> {
	return request(
		target,
		"/api/vault/imports",
		{ method: "POST", body: input },
		vaultHumanAddedImport
	);
}

export function removeVaultImport(
	target: ApiTarget,
	id: string
): Promise<{ ok: boolean; removed: boolean }> {
	return request(
		target,
		`/api/vault/imports/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
		},
		vaultHumanRemoved
	);
}
