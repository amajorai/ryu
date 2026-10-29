import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// Typed client for the user-managed Core Vault surface (`/api/vault/*`).
//
// Listing, versions, audit, and change-request routes return metadata only.
// Plaintext leaves Core only through the explicit `reveal` and `export` routes,
// which require the `read` capability and are audited. Callers must keep those
// values out of long-lived caches (React Query, stores, logs).

import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import type {
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
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

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

export interface VaultSecretBinding {
	id: string;
	kind: "mcp";
}

export interface VaultGenerator {
	charset: string;
	kind: "random";
	length: number;
}

export interface VaultSecretMetadata {
	description: string;
	expandReferences: boolean;
	/** RFC 3339; the value is not resolved after this time. */
	expiresAt: string | null;
	generator: VaultGenerator | null;
	maxVersions: number;
	rotationPeriodSecs: number | null;
	tags: string[];
}

/** A metadata patch: a missing field is unchanged, `null` clears it. */
export type VaultSecretMetadataPatch = Partial<VaultSecretMetadata>;

export interface VaultSecret {
	binding?: VaultSecretBinding;
	capabilities: VaultCapability[];
	createdAt: string | null;
	createdBy: string | null;
	deletedAt: string | null;
	environment: string;
	metadata: VaultSecretMetadata;
	name: string;
	path: string;
	rotatedAt: string | null;
	scope: VaultScope;
	scopeId: string;
	/** `control-plane` for team/org values served by the control plane. */
	source?: "control-plane";
	status: VaultSecretStatus;
	updatedAt: string;
	updatedBy: string | null;
	version: number;
}

export interface VaultState {
	activeEnvironment: string;
	caller: VaultCallerContext | null;
	canManageShared: boolean;
	node: VaultNodeContext;
	seal: VaultSealStatus | null;
	secrets: VaultSecret[];
	sharedError: string | null;
	sharedRemote: boolean;
}

export interface VaultListFilter {
	environment?: string;
	includeDeleted?: boolean;
	path?: string;
	recursive?: boolean;
}

/** Coordinates of one value. `environment` defaults to `default`, `path` to `/`. */
export interface VaultCoords {
	binding?: VaultSecretBinding;
	environment?: string;
	path?: string;
	scope: VaultScope;
	scopeId?: string;
}

export interface SetVaultSecretInput extends VaultCoords {
	/** Optimistic concurrency: the version the caller last saw (409 when stale). */
	expectedVersion?: number;
	metadata?: VaultSecretMetadataPatch;
	/** Omit for a metadata-only update. */
	value?: string;
}

export interface VaultChangeRequest {
	approvals: { at: number | string; by: string }[];
	coords: {
		binding?: VaultSecretBinding;
		environment: string;
		name: string;
		path: string;
		scope: VaultScope;
		scopeId: string;
	};
	decidedAt: string | null;
	decidedBy: string | null;
	hasValue: boolean;
	id: string;
	operation: "write" | "delete";
	/** Core persists a complete serde_json::Value, including scalar/array/null patches. */
	patch: Exclude<AppResponseValue, undefined>;
	reason: string | null;
	requestedAt: string;
	requestedBy: string;
	requiredApprovals: number;
	status: VaultChangeStatus;
}

/** A write either applied immediately or became a change request (HTTP 202). */
export type VaultWriteResult =
	| { kind: "applied"; secret: VaultSecret }
	| { changeRequest: VaultChangeRequest; kind: "pending" };

export type VaultDeleteResult =
	| { kind: "deleted" }
	| { changeRequest: VaultChangeRequest; kind: "pending" };

export interface VaultVersion {
	createdAt: string;
	createdBy: string | null;
	current: boolean;
	destroyed: boolean;
	source: string;
	version: number;
}

export interface VaultEnvironmentList {
	active: string;
	environments: VaultEnvironment[];
}

export interface VaultExportInput {
	environment?: string;
	format: VaultExportFormat;
	k8sName?: string;
	k8sNamespace?: string;
	names?: string[];
	path?: string;
}

export interface VaultImportInput extends VaultCoords {
	content: string;
	format: "dotenv" | "json";
	onConflict?: "skip" | "overwrite";
}

export interface VaultAuditEvent {
	action: string;
	actor: { id: string | null; kind: string };
	at: string;
	/** Audit payloads are complete serde_json::Value, not only object records. */
	details: Exclude<AppResponseValue, undefined>;
	environment?: string;
	name?: string;
	outcome: string;
	path?: string;
	requestId?: string;
	scope?: string;
	scopeId?: string;
	seq: number;
}

export interface VaultAuditPage {
	events: VaultAuditEvent[];
	nextBefore: number | null;
}

// Core's reveal response contains a plaintext string; malformed/missing replies
// keep the existing caller-facing failure rather than exposing a parser error.
const revealReplySchema = z.object({ value: z.string().optional() }).nullish();
// server/vault_api.rs emits {ok:true,destroyed:usize}. Older/no-content replies
// may omit the count; decoding does not impose JavaScript's safe-integer cap.
const destroyReplySchema = z
	.object({
		destroyed: z
			.number()
			.refine((count) => Number.isInteger(count) && count >= 0)
			.optional(),
		ok: z.boolean().optional(),
	})
	.nullish();

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

/** `?a=1&b=2` from defined values only, or `""` when nothing is set. */
export function vaultQueryString(
	params: Record<string, string | number | boolean | undefined>
): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") {
			search.set(key, String(value));
		}
	}
	const text = search.toString();
	return text ? `?${text}` : "";
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

const vaultCallerContextResponseSchema = z
	.object({
		orgId: z.union([z.null(), z.string()]),
		role: z.union([
			z.literal("owner"),
			z.literal("admin"),
			z.literal("member"),
			z.literal("viewer"),
		]),
		teamIds: z.array(z.string()),
		userId: z.string(),
	})
	.passthrough();

const vaultNodeContextResponseSchema = z
	.object({
		id: z.string(),
		orgId: z.union([z.null(), z.string()]),
		ownerUserId: z.union([z.null(), z.string()]),
		scope: z.union([
			z.literal("local"),
			z.literal("org"),
			z.literal("team"),
			z.literal("personal"),
		]),
		teamId: z.union([z.null(), z.string()]),
	})
	.passthrough();

const vaultSealStatusResponseSchema = z
	.object({
		activeKeyVersion: z.number(),
		keyVersions: z.array(z.number()),
		mode: z.union([z.literal("auto"), z.literal("shamir")]),
		progress: z.number(),
		sealed: z.boolean(),
		shares: z.number(),
		threshold: z.number(),
	})
	.passthrough();

const vaultSecretBindingResponseSchema = z
	.object({ id: z.string(), kind: z.literal("mcp") })
	.passthrough();

const vaultGeneratorResponseSchema = z
	.object({
		charset: z.string(),
		kind: z.literal("random"),
		length: z.number(),
	})
	.passthrough();

const vaultSecretMetadataResponseSchema = z
	.object({
		description: z.string(),
		expandReferences: z.boolean(),
		expiresAt: z.union([z.null(), z.string()]),
		generator: z.union([z.null(), vaultGeneratorResponseSchema]),
		maxVersions: z.number(),
		rotationPeriodSecs: z.union([z.null(), z.number()]),
		tags: z.array(z.string()),
	})
	.passthrough();

const vaultSecretWireSchema = z
	.object({
		binding: vaultSecretBindingResponseSchema.optional(),
		capabilities: z
			.array(
				z.union([
					z.literal("admin"),
					z.literal("list"),
					z.literal("use"),
					z.literal("read"),
					z.literal("write"),
					z.literal("delete"),
					z.literal("approve"),
				])
			)
			.optional(),
		createdAt: z.union([z.null(), z.string()]).optional(),
		createdBy: z.union([z.null(), z.string()]).optional(),
		deletedAt: z.union([z.null(), z.string()]).optional(),
		environment: z.string().optional(),
		metadata: vaultSecretMetadataResponseSchema.partial().optional(),
		name: z.string().optional(),
		path: z.string().optional(),
		rotatedAt: z.union([z.null(), z.string()]).optional(),
		scope: z
			.union([
				z.literal("node"),
				z.literal("org"),
				z.literal("team"),
				z.literal("user"),
			])
			.optional(),
		scopeId: z.string().optional(),
		source: z.literal("control-plane").optional(),
		status: z
			.union([
				z.literal("active"),
				z.literal("expired"),
				z.literal("rotation_due"),
				z.literal("deleted"),
			])
			.optional(),
		updatedAt: z.string().optional(),
		updatedBy: z.union([z.null(), z.string()]).optional(),
		version: z.number().optional(),
	})
	.passthrough();

const rawVaultStateResponseSchema = z
	.object({
		caller: z.union([z.null(), vaultCallerContextResponseSchema]),
		canManageShared: z.boolean(),
		node: vaultNodeContextResponseSchema,
		activeEnvironment: z.string().optional(),
		seal: z.union([z.null(), vaultSealStatusResponseSchema]).optional(),
		sharedError: z.union([z.null(), z.string()]).optional(),
		sharedRemote: z.boolean().optional(),
		secrets: z.array(vaultSecretWireSchema).optional(),
	})
	.passthrough();

const vaultVersionResponseSchema = z
	.object({
		createdAt: z.string(),
		createdBy: z.union([z.null(), z.string()]),
		current: z.boolean(),
		destroyed: z.boolean(),
		source: z.string(),
		version: z.number(),
	})
	.passthrough();

const listVaultVersionsResponseSchema = z
	.object({ versions: z.array(vaultVersionResponseSchema).optional() })
	.passthrough();

const vaultExportResultResponseSchema = z
	.object({
		content: z.string(),
		contentType: z.string(),
		count: z.number(),
		environment: z.string(),
		format: z.union([
			z.literal("dotenv"),
			z.literal("json"),
			z.literal("yaml"),
			z.literal("shell"),
			z.literal("k8s-secret"),
		]),
		path: z.string(),
		sharedError: z.string().nullish(),
	})
	.passthrough();

const vaultImportReportResponseSchema = z
	.object({
		created: z.number(),
		skipped: z.number(),
		unchanged: z.number(),
		updated: z.number(),
	})
	.passthrough();

const importVaultSecretsResponseSchema = z
	.object({ report: vaultImportReportResponseSchema.optional() })
	.passthrough();

const vaultEnvironmentResponseSchema = z
	.object({
		name: z.string(),
		position: z.number(),
		protected: z.boolean(),
		requiredApprovals: z.number(),
		slug: z.string(),
	})
	.passthrough();

const listVaultEnvironmentsResponseSchema = z
	.object({
		active: z.string().optional(),
		environments: z.array(vaultEnvironmentResponseSchema).optional(),
	})
	.passthrough();

const listVaultFoldersResponseSchema = z
	.object({ folders: z.array(z.string()).optional() })
	.passthrough();

const vaultAuditVerifyReportResponseSchema = z
	.object({
		firstBadSeq: z.number().optional(),
		ok: z.boolean(),
		rows: z.number(),
	})
	.passthrough();

const verifyVaultAuditResponseSchema = z
	.object({ report: vaultAuditVerifyReportResponseSchema })
	.passthrough();

const vaultSysStatusResponseSchema = z
	.object({
		activeEnvironment: z.string(),
		seal: vaultSealStatusResponseSchema,
		sharedRemote: z.boolean(),
	})
	.passthrough();

const sealVaultResponseSchema = z
	.object({ seal: vaultSealStatusResponseSchema })
	.passthrough();

const unsealVaultResponseSchema = z
	.object({ seal: vaultSealStatusResponseSchema })
	.passthrough();

const vaultChangeApprovalSchema = z
	.object({ at: z.union([z.string(), z.number()]), by: z.string() })
	.passthrough();

const vaultChangeBindingSchema = z
	.object({ id: z.string(), kind: z.literal("mcp") })
	.passthrough();

const vaultChangeCoordsSchema = z
	.object({
		binding: vaultChangeBindingSchema.optional(),
		environment: z.string(),
		name: z.string(),
		path: z.string(),
		scope: z.union([
			z.literal("user"),
			z.literal("node"),
			z.literal("team"),
			z.literal("org"),
		]),
		scopeId: z.string(),
	})
	.passthrough();

const vaultChangeRequestResponseSchema = z
	.object({
		approvals: z.array(vaultChangeApprovalSchema),
		coords: vaultChangeCoordsSchema,
		decidedAt: z.union([z.null(), z.string()]),
		decidedBy: z.union([z.null(), z.string()]),
		hasValue: z.boolean(),
		id: z.string(),
		operation: z.union([z.literal("write"), z.literal("delete")]),
		patch: appResponseValueSchema.nonoptional(),
		reason: z.union([z.null(), z.string()]),
		requestedAt: z.string(),
		requestedBy: z.string(),
		requiredApprovals: z.number(),
		status: z.union([
			z.literal("pending"),
			z.literal("applied"),
			z.literal("rejected"),
			z.literal("canceled"),
		]),
	})
	.passthrough();

const rawWriteResponseSchema = z
	.object({
		changeRequest: vaultChangeRequestResponseSchema.optional(),
		secret: vaultSecretWireSchema.optional(),
	})
	.passthrough();

const listVaultChangeRequestsResponseSchema = z
	.object({
		changeRequests: z.array(vaultChangeRequestResponseSchema).optional(),
	})
	.passthrough();

const decideVaultChangeRequestResponseSchema = z
	.object({ changeRequest: vaultChangeRequestResponseSchema.optional() })
	.passthrough();

const listVaultAuditResponseEventsItemActorSchema = z
	.object({ id: z.union([z.null(), z.string()]), kind: z.string() })
	.passthrough();

const vaultAuditEventResponseSchema = z
	.object({
		action: z.string(),
		actor: listVaultAuditResponseEventsItemActorSchema,
		at: z.string(),
		details: appResponseValueSchema.nonoptional(),
		environment: z.string().optional(),
		name: z.string().optional(),
		outcome: z.string(),
		path: z.string().optional(),
		requestId: z.string().optional(),
		scope: z.string().optional(),
		scopeId: z.string().optional(),
		seq: z.number(),
	})
	.passthrough();

const listVaultAuditResponseSchema = z
	.object({
		events: z.array(vaultAuditEventResponseSchema).optional(),
		nextBefore: z.union([z.null(), z.number()]).optional(),
	})
	.passthrough();

// ── Credential broker ────────────────────────────────────────────────────────
// Services and proposals carry hosts and `secret:` references, never values.

export interface VaultBrokerService {
	createdAt: string;
	description?: string;
	enabled: boolean;
	environment: string;
	host: string;
	name: string;
	pathPrefix: string;
	port?: number;
	updatedAt: string;
}

export interface VaultBrokerProposal {
	createdAt: string;
	credentials: { description?: string; ref: string }[];
	/** Set on a password-manager credential-use request: the first use of an
	 *  `op://` / `bws://` reference by `subject`. */
	credentialUse?: {
		account: string;
		provider: string;
		ref: string;
		subject: string;
	};
	environment: string;
	expiresAt: string;
	id: string;
	message: string;
	requestedBy: string;
	services: { host?: string; name?: string }[];
	status: "pending" | "approved" | "rejected" | "expired";
}

const vaultBrokerServiceResponseSchema = z
	.object({
		createdAt: z.string(),
		description: z.string().optional(),
		enabled: z.boolean(),
		environment: z.string(),
		host: z.string(),
		name: z.string(),
		pathPrefix: z.string(),
		port: z.number().optional(),
		updatedAt: z.string(),
	})
	.passthrough();

const listVaultBrokerServicesResponseSchema = z
	.object({ services: z.array(vaultBrokerServiceResponseSchema).optional() })
	.passthrough();

const vaultBrokerProposalResponseSchema = z
	.object({
		createdAt: z.string(),
		credentials: z.array(
			z
				.object({ description: z.string().optional(), ref: z.string() })
				.passthrough()
		),
		credentialUse: z
			.object({
				account: z.string(),
				provider: z.string(),
				ref: z.string(),
				subject: z.string(),
			})
			.passthrough()
			.optional(),
		environment: z.string(),
		expiresAt: z.string(),
		id: z.string(),
		message: z.string(),
		requestedBy: z.string(),
		services: z.array(
			z
				.object({ host: z.string().optional(), name: z.string().optional() })
				.passthrough()
		),
		status: z.union([
			z.literal("pending"),
			z.literal("approved"),
			z.literal("rejected"),
			z.literal("expired"),
		]),
	})
	.passthrough();

const listVaultBrokerProposalsResponseSchema = z
	.object({ proposals: z.array(vaultBrokerProposalResponseSchema).optional() })
	.passthrough();

export async function listVaultBrokerServices(
	target: ApiTarget
): Promise<VaultBrokerService[]> {
	const raw = await request(
		target,
		"/api/vault/broker/services",
		undefined,
		listVaultBrokerServicesResponseSchema
	);
	return raw?.services ?? [];
}

export async function listVaultBrokerProposals(
	target: ApiTarget
): Promise<VaultBrokerProposal[]> {
	const raw = await request(
		target,
		`/api/vault/broker/proposals${vaultQueryString({ status: "pending" })}`,
		undefined,
		listVaultBrokerProposalsResponseSchema
	);
	return raw?.proposals ?? [];
}

/** Approving creates the proposed services. Requested credentials are stored
 *  separately (in the Secrets tab), so the page sends no values. Approving a
 *  password-manager credential-use request records a grant for `grant`
 *  (Core defaults to 30 days). */
export async function decideVaultBrokerProposal(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject",
	grant?: VaultPasswordManagerGrantMode
): Promise<void> {
	await request(
		target,
		`/api/vault/broker/proposals/${encodeURIComponent(id)}/${decision}`,
		{ body: decision === "approve" && grant ? { grant } : {}, method: "POST" },
		appResponseValueSchema
	);
}

// ── Payment card spend approvals ─────────────────────────────────────────────
// Approval requests carry the card's brand, last four digits, and merchant
// host, never the card number or security code.

export interface VaultCardApproval {
	agent: string;
	brand?: string;
	channel: "broker" | "fill" | "reveal";
	environment: string;
	/** The field a reveal asks for (`number` or `cvc`); absent otherwise. */
	field?: "number" | "cvc";
	id: string;
	key: string;
	last4?: string;
	merchantHost: string;
	requestExpiresAt: string;
	requestedAt: string;
	requester: string;
	status:
		| "pending"
		| "approved"
		| "rejected"
		| "expired"
		| "consumed"
		| "revoked";
}

const vaultCardApprovalResponseSchema = z
	.object({
		agent: z.string(),
		brand: z.string().optional(),
		channel: z.union([
			z.literal("broker"),
			z.literal("fill"),
			z.literal("reveal"),
		]),
		environment: z.string(),
		field: z.union([z.literal("number"), z.literal("cvc")]).optional(),
		id: z.string(),
		key: z.string(),
		last4: z.string().optional(),
		merchantHost: z.string(),
		requestExpiresAt: z.string(),
		requestedAt: z.string(),
		requester: z.string(),
		status: z.union([
			z.literal("pending"),
			z.literal("approved"),
			z.literal("rejected"),
			z.literal("expired"),
			z.literal("consumed"),
			z.literal("revoked"),
		]),
	})
	.passthrough();

const listVaultCardApprovalsResponseSchema = z
	.object({ approvals: z.array(vaultCardApprovalResponseSchema).optional() })
	.passthrough();

export async function listVaultCardApprovals(
	target: ApiTarget
): Promise<VaultCardApproval[]> {
	const raw = await request(
		target,
		`/api/vault/cards/approvals${vaultQueryString({ status: "pending" })}`,
		undefined,
		listVaultCardApprovalsResponseSchema
	);
	return raw?.approvals ?? [];
}

/** `once` releases one use; `grant` lets the requesting session use the card
 *  at that merchant until `ttlSecs` (default 15 minutes) runs out. */
export type VaultCardDecision = "reject" | "once" | "grant";

export async function decideVaultCardApproval(
	target: ApiTarget,
	id: string,
	decision: VaultCardDecision
): Promise<void> {
	const path = `/api/vault/cards/approvals/${encodeURIComponent(id)}`;
	if (decision === "reject") {
		await request(
			target,
			`${path}/reject`,
			{ body: {}, method: "POST" },
			appResponseValueSchema
		);
		return;
	}
	await request(
		target,
		`${path}/approve`,
		{
			body:
				decision === "grant"
					? { mode: "grant", subject: "session", ttlSecs: 900 }
					: { mode: "once" },
			method: "POST",
		},
		appResponseValueSchema
	);
}
