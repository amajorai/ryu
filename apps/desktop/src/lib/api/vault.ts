// Typed client for the user-managed Core Vault surface (`/api/vault/*`).
//
// Listing, versions, audit, and change-request routes return metadata only.
// Plaintext leaves Core only through the explicit `reveal` and `export` routes,
// which require the `read` capability and are audited. Callers must keep those
// values out of long-lived caches (React Query, stores, logs). Shapes live in
// `vault-types.ts`, codecs in `vault-schemas.ts`, audit and seal calls in
// `vault-sys.ts`, and the credential broker in `vault-broker.ts`.

import type {
	VaultChangeStatus,
	VaultExportResult,
	VaultImportReport,
	VaultSecretStatus,
} from "@ryuhq/core-client/vault.ts";
import { type ApiTarget, request } from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import { vaultQueryString } from "./vault-query.ts";
import {
	decideVaultChangeRequestResponseSchema,
	destroyReplySchema,
	importVaultSecretsResponseSchema,
	listVaultChangeRequestsResponseSchema,
	listVaultEnvironmentsResponseSchema,
	listVaultFoldersResponseSchema,
	listVaultVersionsResponseSchema,
	rawVaultStateResponseSchema,
	rawWriteResponseSchema,
	revealReplySchema,
	vaultExportResultResponseSchema,
} from "./vault-schemas.ts";
import type {
	SetVaultSecretInput,
	VaultChangeRequest,
	VaultCoords,
	VaultDeleteResult,
	VaultEnvironmentList,
	VaultExportInput,
	VaultImportInput,
	VaultListFilter,
	VaultSecret,
	VaultSecretMetadata,
	VaultState,
	VaultVersion,
	VaultWriteResult,
} from "./vault-types.ts";

export type {
	VaultAuditQuery,
	VaultAuditVerifyReport,
	VaultCallerContext,
	VaultCapability,
	VaultChangeStatus,
	VaultEnvironment,
	VaultExportFormat,
	VaultExportResult,
	VaultImportReport,
	VaultNodeContext,
	VaultPasswordManagerGrantMode,
	VaultScope,
	VaultSealStatus,
	VaultSecretStatus,
	VaultSysStatus,
} from "@ryuhq/core-client/vault.ts";
export { vaultQueryString } from "./vault-query.ts";
export {
	getVaultSysStatus,
	listVaultAudit,
	sealVault,
	unsealVault,
	verifyVaultAudit,
} from "./vault-sys.ts";
export type {
	SetVaultSecretInput,
	VaultAuditEvent,
	VaultAuditPage,
	VaultChangeRequest,
	VaultCoords,
	VaultDeleteResult,
	VaultEnvironmentList,
	VaultExportInput,
	VaultGenerator,
	VaultImportInput,
	VaultListFilter,
	VaultSecret,
	VaultSecretBinding,
	VaultSecretMetadata,
	VaultSecretMetadataPatch,
	VaultState,
	VaultVersion,
	VaultWriteResult,
} from "./vault-types.ts";

const DEFAULT_ENVIRONMENT = "default";
const ROOT_PATH = "/";

const SECRET_STATUSES = new Set<VaultSecretStatus>([
	"active",
	"expired",
	"rotation_due",
	"deleted",
]);

function secretPath(name: string, suffix = ""): string {
	return `/api/vault/secrets/${encodeURIComponent(name)}${suffix}`;
}

/** The coordinates of a listed secret, for follow-up calls on the same value. */
export function vaultCoordsOf(secret: VaultSecret): VaultCoords {
	const coords: VaultCoords = {
		scope: secret.scope,
		scopeId: secret.scopeId,
		environment: secret.environment,
		path: secret.path,
	};
	if (secret.binding) {
		coords.binding = secret.binding;
	}
	return coords;
}

/**
 * Fill defaults for fields an older Core or the control plane may omit, so the
 * page never branches on `undefined` for a value Core always sends today.
 */
type VaultSecretWire = Omit<Partial<VaultSecret>, "metadata"> & {
	metadata?: Partial<VaultSecretMetadata>;
};

export function normalizeVaultSecret(raw: VaultSecretWire): VaultSecret {
	const metadata: Partial<VaultSecretMetadata> = raw.metadata ?? {};
	const status =
		raw.status && SECRET_STATUSES.has(raw.status) ? raw.status : "active";
	return {
		...raw,
		name: raw.name ?? "",
		scope: raw.scope ?? "user",
		scopeId: raw.scopeId ?? "",
		environment: raw.environment ?? DEFAULT_ENVIRONMENT,
		path: raw.path ?? ROOT_PATH,
		version: raw.version ?? 1,
		status: raw.deletedAt ? "deleted" : status,
		capabilities: raw.capabilities ?? [],
		createdAt: raw.createdAt ?? null,
		createdBy: raw.createdBy ?? null,
		updatedAt: raw.updatedAt ?? "",
		updatedBy: raw.updatedBy ?? null,
		rotatedAt: raw.rotatedAt ?? null,
		deletedAt: raw.deletedAt ?? null,
		metadata: {
			description: metadata.description ?? "",
			tags: metadata.tags ?? [],
			expiresAt: metadata.expiresAt ?? null,
			rotationPeriodSecs: metadata.rotationPeriodSecs ?? null,
			generator: metadata.generator ?? null,
			expandReferences: metadata.expandReferences ?? false,
			maxVersions: metadata.maxVersions ?? 20,
		},
	};
}

export async function listVaultSecrets(
	target: ApiTarget,
	filter: VaultListFilter = {}
): Promise<VaultState> {
	const raw = await request(
		target,
		`/api/vault/secrets${vaultQueryString({
			environment: filter.environment,
			path: filter.path,
			recursive: filter.recursive,
			includeDeleted: filter.includeDeleted || undefined,
		})}`,
		undefined,
		rawVaultStateResponseSchema
	);
	return {
		...raw,
		activeEnvironment: raw.activeEnvironment ?? DEFAULT_ENVIRONMENT,
		seal: raw.seal ?? null,
		sharedError: raw.sharedError ?? null,
		sharedRemote: raw.sharedRemote ?? false,
		secrets: (raw.secrets ?? []).map(normalizeVaultSecret),
	};
}

interface RawWriteResponse {
	changeRequest?: VaultChangeRequest;
	secret?: VaultSecretWire;
}

function writeResult(raw: RawWriteResponse | undefined): VaultWriteResult {
	if (raw?.changeRequest) {
		return { kind: "pending", changeRequest: raw.changeRequest };
	}
	return { kind: "applied", secret: normalizeVaultSecret(raw?.secret ?? {}) };
}

/** Write a value and/or metadata. A protected environment answers 202 with a change request. */
export async function setVaultSecret(
	target: ApiTarget,
	name: string,
	input: SetVaultSecretInput
): Promise<VaultWriteResult> {
	const raw = await request(
		target,
		secretPath(name),
		{
			body: input,
			method: "PUT",
		},
		rawWriteResponseSchema
	);
	return writeResult(raw);
}

/** Soft-delete a value (restorable). A protected environment answers 202. */
export async function deleteVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords
): Promise<VaultDeleteResult> {
	const raw = await request(
		target,
		secretPath(name),
		{
			body: coords,
			method: "DELETE",
		},
		rawWriteResponseSchema
	);
	if (raw?.changeRequest) {
		return { kind: "pending", changeRequest: raw.changeRequest };
	}
	return { kind: "deleted" };
}

export async function listVaultVersions(
	target: ApiTarget,
	name: string,
	coords: VaultCoords
): Promise<VaultVersion[]> {
	const query = vaultQueryString({
		scope: coords.scope,
		scopeId: coords.scopeId,
		environment: coords.environment,
		path: coords.path,
		mcpId: coords.binding?.id,
	});
	const raw = await request(
		target,
		secretPath(name, `/versions${query}`),
		undefined,
		listVaultVersionsResponseSchema
	);
	return raw?.versions ?? [];
}

/**
 * Reveal a value (requires `read`; audited). The caller owns the returned
 * plaintext and must drop it as soon as it is no longer shown.
 */
export async function revealVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords,
	version?: number
): Promise<string> {
	const body: VaultCoords & { version?: number } = { ...coords };
	if (version !== undefined) {
		body.version = version;
	}
	const raw = await request(
		target,
		secretPath(name, "/reveal"),
		{
			body,
			method: "POST",
		},
		gatewayJsonValueSchema
	);
	const reply = revealReplySchema.safeParse(raw);
	if (!reply.success || reply.data?.value === undefined) {
		throw new Error("Core did not return a value.");
	}
	return reply.data.value;
}

async function secretAction(
	target: ApiTarget,
	name: string,
	action: "rollback" | "restore",
	body: VaultCoords & { version?: number }
): Promise<VaultSecret> {
	const raw = await request(
		target,
		secretPath(name, `/${action}`),
		{ body, method: "POST" },
		rawWriteResponseSchema
	);
	return normalizeVaultSecret(raw?.secret ?? {});
}

/** Make an older version current again (writes a new version). */
export async function rollbackVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords,
	version: number
): Promise<VaultSecret> {
	return await secretAction(target, name, "rollback", { ...coords, version });
}

/** Undo a soft delete. */
export async function restoreVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords
): Promise<VaultSecret> {
	return await secretAction(target, name, "restore", coords);
}

/** Permanently destroy specific versions, or every version when omitted. */
export async function destroyVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords,
	versions?: number[]
): Promise<number | undefined> {
	const body: VaultCoords & { versions?: number[] } = { ...coords };
	if (versions) {
		body.versions = versions;
	}
	const raw = await request(
		target,
		secretPath(name, "/destroy"),
		{
			body,
			method: "POST",
		},
		gatewayJsonValueSchema
	);
	return destroyReplySchema.parse(raw)?.destroyed;
}

/** Render effective values (requires `read` on each; audited). Never cache the result. */
export async function exportVaultSecrets(
	target: ApiTarget,
	input: VaultExportInput
): Promise<VaultExportResult> {
	return await request(
		target,
		"/api/vault/export",
		{
			body: input,
			method: "POST",
		},
		vaultExportResultResponseSchema
	);
}

export async function importVaultSecrets(
	target: ApiTarget,
	input: VaultImportInput
): Promise<VaultImportReport> {
	const raw = await request(
		target,
		"/api/vault/import",
		{ body: input, method: "POST" },
		importVaultSecretsResponseSchema
	);
	return raw?.report ?? { created: 0, updated: 0, skipped: 0, unchanged: 0 };
}

export async function listVaultEnvironments(
	target: ApiTarget
): Promise<VaultEnvironmentList> {
	const raw = await request(
		target,
		"/api/vault/environments",
		undefined,
		listVaultEnvironmentsResponseSchema
	);
	return {
		active: raw?.active ?? DEFAULT_ENVIRONMENT,
		environments: raw?.environments ?? [],
	};
}

export async function listVaultFolders(
	target: ApiTarget,
	environment: string
): Promise<string[]> {
	const raw = await request(
		target,
		`/api/vault/folders${vaultQueryString({ environment })}`,
		undefined,
		listVaultFoldersResponseSchema
	);
	return raw?.folders ?? [];
}

export async function listVaultChangeRequests(
	target: ApiTarget,
	status?: VaultChangeStatus
): Promise<VaultChangeRequest[]> {
	const raw = await request(
		target,
		`/api/vault/change-requests${vaultQueryString({ status })}`,
		undefined,
		listVaultChangeRequestsResponseSchema
	);
	return raw?.changeRequests ?? [];
}

export async function decideVaultChangeRequest(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject" | "cancel",
	reason?: string
): Promise<VaultChangeRequest | null> {
	const raw = await request(
		target,
		`/api/vault/change-requests/${encodeURIComponent(id)}/${decision}`,
		{ body: reason ? { reason } : {}, method: "POST" },
		decideVaultChangeRequestResponseSchema
	);
	return raw?.changeRequest ?? null;
}
