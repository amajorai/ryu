// packages/core-client/src/vault/values.ts
//
// Values: part of the Secret Vault client. `../vault.ts` re-exports these names
// and documents the wire conventions.

import type { AppJsonValue } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import {
	vaultHumanDelete,
	vaultHumanDestroyed,
	vaultHumanVersions,
	vaultHumanWrite,
} from "./codecs-human.ts";
import { vaultMachineValueResponse } from "./codecs-machine.ts";
import { vaultHumanList } from "./codecs-reply.ts";
import { query, secretPath } from "./internal.ts";
import type {
	VaultBinding,
	VaultCallerContext,
	VaultCoords,
	VaultNodeContext,
	VaultResolvedCoords,
	VaultScope,
	VaultSealStatus,
	VaultSecret,
	VaultSecretMetadataPatch,
	VaultTimestamp,
} from "./shared.ts";

export interface VaultListQuery {
	environment?: string;
	includeDeleted?: boolean;
	path?: string;
	/** Include sub-folders (Core default: true). */
	recursive?: boolean;
}

export interface VaultListResponse {
	activeEnvironment: string;
	caller: VaultCallerContext | null;
	canManageShared: boolean;
	node: VaultNodeContext;
	seal: VaultSealStatus;
	secrets: VaultSecret[];
	sharedError: string | null;
	sharedRemote: boolean;
}

export interface PutVaultSecretInput extends VaultCoords {
	/** Optimistic concurrency: the version the caller last saw. */
	expectedVersion?: number;
	metadata?: VaultSecretMetadataPatch;
	/** Omit for a metadata-only update. An empty string deletes (legacy). */
	value?: string;
}

export type VaultChangeOperation = "write" | "delete";

export type VaultChangeStatus = "pending" | "applied" | "rejected" | "canceled";

export interface VaultApproval {
	/** RFC 3339 after rendering, or the raw epoch if chrono cannot represent it. */
	at: VaultTimestamp | null;
	by: string;
}

export interface VaultChangeRequest {
	approvals: VaultApproval[];
	coords: VaultResolvedCoords;
	decidedAt: VaultTimestamp | null;
	decidedBy: string | null;
	hasValue: boolean;
	id: string;
	operation: VaultChangeOperation;
	patch: AppJsonValue;
	reason: string | null;
	requestedAt: VaultTimestamp | null;
	requestedBy: string;
	requiredApprovals: number;
	status: VaultChangeStatus;
}

/** A write either applies (`secret`) or, in a protected environment, opens a
 *  change request (HTTP 202, `changeRequest`). */
export interface VaultWriteResult {
	changeRequest?: VaultChangeRequest;
	ok: boolean;
	secret?: VaultSecret;
}

export interface VaultDeleteResult {
	binding?: VaultBinding | null;
	changeRequest?: VaultChangeRequest;
	deleted?: boolean;
	environment?: string;
	name?: string;
	ok: boolean;
	path?: string;
	scope?: VaultScope;
	scopeId?: string;
}

export interface VaultSecretVersion {
	createdAt: VaultTimestamp | null;
	createdBy: string | null;
	current: boolean;
	destroyed: boolean;
	source: string;
	version: number;
}

function coordsQuery(coords: VaultCoords): string {
	return query({
		scope: coords.scope,
		scopeId: coords.scopeId,
		mcpId: coords.binding?.id,
		environment: coords.environment,
		path: coords.path,
	});
}

export function listVaultSecrets(
	target: ApiTarget,
	filter: VaultListQuery = {},
	signal?: AbortSignal
): Promise<VaultListResponse> {
	return request(
		target,
		`/api/vault/secrets${query({
			environment: filter.environment,
			path: filter.path,
			recursive: filter.recursive,
			includeDeleted: filter.includeDeleted,
		})}`,
		{ signal },
		vaultHumanList
	);
}

export function putVaultSecret(
	target: ApiTarget,
	name: string,
	input: PutVaultSecretInput
): Promise<VaultWriteResult> {
	return request(
		target,
		secretPath(name),
		{ method: "PUT", body: input },
		vaultHumanWrite
	);
}

/** Soft-delete (restorable). Core requires the coordinates as a JSON body. */
export function deleteVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords
): Promise<VaultDeleteResult> {
	return request(
		target,
		secretPath(name),
		{ method: "DELETE", body: coords },
		vaultHumanDelete
	);
}

export function listVaultSecretVersions(
	target: ApiTarget,
	name: string,
	coords: VaultCoords
): Promise<{ versions: VaultSecretVersion[] }> {
	return request(
		target,
		`${secretPath(name, "/versions")}${coordsQuery(coords)}`,
		{},
		vaultHumanVersions
	);
}

/** Reveal a value (requires `read`; audited). Omit `version` for the current one. */
export function revealVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords & { version?: number }
): Promise<{ value: string }> {
	return request(
		target,
		secretPath(name, "/reveal"),
		{
			method: "POST",
			body: coords,
		},
		vaultMachineValueResponse
	);
}

export function rollbackVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords & { version: number }
): Promise<VaultWriteResult> {
	return request(
		target,
		secretPath(name, "/rollback"),
		{
			method: "POST",
			body: coords,
		},
		vaultHumanWrite
	);
}

export function restoreVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords
): Promise<VaultWriteResult> {
	return request(
		target,
		secretPath(name, "/restore"),
		{
			method: "POST",
			body: coords,
		},
		vaultHumanWrite
	);
}

/** Permanently destroy versions (all when `versions` is omitted). */
export function destroyVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords & { versions?: number[] }
): Promise<{ destroyed: number; ok: boolean }> {
	return request(
		target,
		secretPath(name, "/destroy"),
		{
			method: "POST",
			body: coords,
		},
		vaultHumanDestroyed
	);
}
