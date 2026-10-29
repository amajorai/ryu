// packages/core-client/src/vault.ts
//
// Typed client for Core's Secret Vault (`/api/vault/*`). Human routes ride the
// normal node bearer (plus the optional user JWT) through {@link request}.
// Machine routes (`/api/vault/auth/*` login and `/api/vault/agent/*`) are public
// mounts that authenticate in-handler, so they use {@link VaultAgentTarget} and
// send only `x-ryu-vault-token`: a CI runner never needs the node bearer.
//
// Wire conventions: JSON is camelCase. Core's response renderer formats epoch
// fields including `…At`, `notAfter`, `notBefore`, `validAfter`, `validBefore`,
// and approval `at` as RFC 3339 strings; out-of-range epochs remain numeric.
// Machine response codecs below model that native domain. The legacy human
// response declarations are separate. Secret values only appear in explicit
// reveal/export/issue responses, never in listings, versions, or audit rows.

import { z } from "zod";
import {
	type AppJsonValue,
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";

interface VaultExportValues {
	[name: string]: string;
}
interface VaultMachineHeaders {
	[name: string]: string;
}
const vaultExportObject = z.custom<
	Record<string, z.output<typeof appResponseValueSchema>>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		z.record(z.string(), appResponseValueSchema).safeParse(value).success
);

import {
	type ApiTarget,
	apiErrorFromBody,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	type RyuFetch,
	request,
} from "./client.ts";

/** Header carrying a machine vault token on `/api/vault/agent/*`. */
export const VAULT_TOKEN_HEADER = "x-ryu-vault-token";

// ── Shared vocabulary ────────────────────────────────────────────────────────

export type VaultTimestamp = string | number;

export type VaultScope = "user" | "node" | "team" | "org";

export type VaultCapability =
	| "list"
	| "use"
	| "read"
	| "write"
	| "delete"
	| "admin"
	| "approve";

export type VaultSecretStatus =
	| "active"
	| "expired"
	| "rotation_due"
	| "deleted";

export interface VaultBinding {
	id: string;
	kind: "mcp";
}

/** Coordinates of one value. `environment` defaults to `default`, `path` to `/`. */
export interface VaultCoords {
	binding?: VaultBinding;
	environment?: string;
	path?: string;
	scope: VaultScope;
	scopeId?: string;
}

/** Fully resolved coordinates as Core reports them. */
export interface VaultResolvedCoords {
	binding?: VaultBinding;
	environment: string;
	name: string;
	path: string;
	scope: VaultScope;
	scopeId: string;
}

export type VaultCharset = "alphanumeric" | "hex" | "base64url" | "symbols";

export interface VaultGenerator {
	charset: VaultCharset;
	kind: "random";
	length: number;
}

export interface VaultSecretMetadata {
	description: string;
	expandReferences: boolean;
	/** RFC 3339. */
	expiresAt: VaultTimestamp | null;
	generator: VaultGenerator | null;
	maxVersions: number;
	rotationPeriodSecs: number | null;
	tags: string[];
}

/** A partial metadata update. Omitted fields are unchanged; `null` clears. */
export interface VaultSecretMetadataPatch {
	description?: string;
	expandReferences?: boolean;
	/** RFC 3339, or null to clear. */
	expiresAt?: string | null;
	generator?: VaultGenerator | null;
	maxVersions?: number;
	rotationPeriodSecs?: number | null;
	tags?: string[];
}

export interface VaultSecret extends VaultResolvedCoords {
	capabilities: VaultCapability[];
	createdAt: VaultTimestamp | null;
	createdBy: string | null;
	deletedAt?: VaultTimestamp | null;
	metadata: VaultSecretMetadata;
	rotatedAt: VaultTimestamp | null;
	/** `control-plane` for team/org values served by the control plane. */
	source?: string;
	status: VaultSecretStatus;
	updatedAt: VaultTimestamp | null;
	updatedBy: string | null;
	version: number;
}

export interface VaultSealStatus {
	activeKeyVersion: number;
	keyVersions: number[];
	mode: "auto" | "shamir";
	progress: number;
	sealed: boolean;
	shares: number;
	threshold: number;
}

export interface VaultNodeContext {
	id: string;
	orgId: string | null;
	ownerUserId: string | null;
	scope: "local" | "org" | "team" | "personal";
	teamId: string | null;
}

export interface VaultCallerContext {
	orgId: string | null;
	role: "owner" | "admin" | "member" | "viewer";
	teamIds: string[];
	userId: string;
}

// ── Values ───────────────────────────────────────────────────────────────────

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

function secretPath(name: string, suffix = ""): string {
	return `/api/vault/secrets/${encodeURIComponent(name)}${suffix}`;
}

function query(
	params: Record<string, string | number | boolean | undefined>
): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			search.set(key, String(value));
		}
	}
	const text = search.toString();
	return text ? `?${text}` : "";
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

// ── Export, import, snapshot, scan ───────────────────────────────────────────

export type VaultExportFormat =
	| "dotenv"
	| "json"
	| "yaml"
	| "shell"
	| "k8s-secret";

export interface VaultExportInput {
	environment?: string;
	format?: VaultExportFormat;
	k8sName?: string;
	k8sNamespace?: string;
	/** Restrict the export to these names. */
	names?: string[];
	path?: string;
}

export interface VaultExportResult {
	content: string;
	contentType: string;
	count: number;
	environment: string;
	format: VaultExportFormat;
	path: string;
	/**
	 * Set when the control plane could not be reached: the export holds only
	 * your own and this node's values, without Team and Organization values.
	 */
	sharedError?: string | null;
}

/** Render the effective values for an environment/folder (requires `read`). */
export function exportVaultSecrets(
	target: ApiTarget,
	input: VaultExportInput = {}
): Promise<VaultExportResult> {
	return request(
		target,
		"/api/vault/export",
		{ method: "POST", body: input },
		vaultMachineExportResponse
	);
}

/** Parse a `format: "json"` export into a name→value map. */
export function parseVaultJsonExport(
	result: VaultExportResult
): VaultExportValues {
	const parsed = vaultExportObject.safeParse(JSON.parse(result.content));
	if (!parsed.success) {
		throw new Error("Vault export is not a JSON object");
	}
	const values: VaultExportValues = {};
	for (const [key, value] of Object.entries(parsed.data)) {
		const text = z.string().safeParse(value);
		if (text.success) {
			values[key] = text.data;
		}
	}
	return values;
}

export type VaultImportFormat = "dotenv" | "json" | "snapshot";

export type VaultOnConflict = "skip" | "overwrite";

export interface VaultImportInput extends VaultCoords {
	content: string;
	format: VaultImportFormat;
	onConflict?: VaultOnConflict;
	/** Required for `snapshot`. */
	passphrase?: string;
}

export interface VaultImportReport {
	created: number;
	skipped: number;
	unchanged: number;
	updated: number;
}

export function importVaultSecrets(
	target: ApiTarget,
	input: VaultImportInput
): Promise<{ ok: boolean; report: VaultImportReport }> {
	return request(
		target,
		"/api/vault/import",
		{ method: "POST", body: input },
		vaultHumanImported
	);
}

export interface VaultSnapshotEnvelope {
	ciphertext: string;
	createdAt: string;
	format: string;
	kdf: { alg: string; iterations: number; salt: string };
	nonce: string;
	version: number;
}

/** Export a passphrase-sealed, portable snapshot of readable values. */
export function exportVaultSnapshot(
	target: ApiTarget,
	input: { environment?: string; passphrase: string; path?: string }
): Promise<VaultSnapshotEnvelope> {
	return request(
		target,
		"/api/vault/snapshot",
		{
			method: "POST",
			body: input,
		},
		vaultHumanSnapshot
	);
}

export interface VaultScanFile {
	content: string;
	path?: string;
}

export interface VaultScanInput {
	/** Finding fingerprints to suppress. */
	allow?: string[];
	files: VaultScanFile[];
	/** Also match stored values the caller may read (Core default: true). */
	knownValues?: boolean;
}

export interface VaultFinding {
	column: number;
	description: string;
	fingerprint: string;
	line: number;
	/** Redacted preview of the match. */
	preview: string;
	rule: string;
	/** For `vault-value` findings, the `ENV/folder/NAME` that leaked. */
	secret?: string;
	source?: string;
}

export function scanForVaultSecrets(
	target: ApiTarget,
	input: VaultScanInput
): Promise<{ findings: VaultFinding[] }> {
	return request(
		target,
		"/api/vault/scan",
		{ method: "POST", body: input },
		vaultHumanFindings
	);
}

// ── Environments, folders, imports ───────────────────────────────────────────

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

// ── Policies and bindings ────────────────────────────────────────────────────

export interface VaultPolicyRule {
	capabilities: VaultCapability[];
	deny?: boolean;
	/** Glob over `ENV/folder/NAME` or a `sys/…` key. */
	path: string;
}

export interface VaultPolicy {
	description: string;
	name: string;
	rules: VaultPolicyRule[];
}

export interface VaultPolicyBinding {
	expiresAt?: VaultTimestamp;
	id: string;
	policy: string;
	/** `user:<id>`, `team:<id>`, `role:<name>`, or `machine:<id>`. */
	subject: string;
}

export function listVaultPolicies(
	target: ApiTarget
): Promise<{ bindings: VaultPolicyBinding[]; policies: VaultPolicy[] }> {
	return request(target, "/api/vault/policies", {}, vaultHumanPolicies);
}

export function putVaultPolicy(
	target: ApiTarget,
	name: string,
	input: { description?: string; rules: VaultPolicyRule[] }
): Promise<{ ok: boolean; policy: VaultPolicy }> {
	return request(
		target,
		`/api/vault/policies/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			body: input,
		},
		vaultHumanPutPolicy
	);
}

export function deleteVaultPolicy(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean; ok: boolean }> {
	return request(
		target,
		`/api/vault/policies/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeleted
	);
}

export function bindVaultPolicy(
	target: ApiTarget,
	input: { expiresAt?: string; policy: string; subject: string }
): Promise<{ binding: VaultPolicyBinding; ok: boolean }> {
	return request(
		target,
		"/api/vault/policy-bindings",
		{
			method: "POST",
			body: input,
		},
		vaultHumanBoundPolicy
	);
}

export function unbindVaultPolicy(
	target: ApiTarget,
	id: string
): Promise<{ ok: boolean; removed: boolean }> {
	return request(
		target,
		`/api/vault/policy-bindings/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
		},
		vaultHumanRemoved
	);
}

// ── Change requests ──────────────────────────────────────────────────────────

export type VaultChangeDecision = "approve" | "reject" | "cancel";

export function listVaultChangeRequests(
	target: ApiTarget,
	status?: VaultChangeStatus
): Promise<{ changeRequests: VaultChangeRequest[] }> {
	return request(
		target,
		`/api/vault/change-requests${query({ status })}`,
		{},
		vaultHumanChanges
	);
}

export function decideVaultChangeRequest(
	target: ApiTarget,
	id: string,
	decision: VaultChangeDecision,
	reason?: string
): Promise<{ changeRequest: VaultChangeRequest; ok: boolean }> {
	return request(
		target,
		`/api/vault/change-requests/${encodeURIComponent(id)}/${decision}`,
		{ method: "POST", body: reason === undefined ? {} : { reason } },
		vaultHumanDecidedChange
	);
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface VaultAuditQuery {
	action?: string;
	actorId?: string;
	/** Return rows with `seq` below this (paging cursor from `nextBefore`). */
	before?: number;
	environment?: string;
	limit?: number;
	name?: string;
}

export interface VaultAuditEvent {
	action: string;
	actor: { id: string | null; kind: string };
	/** RFC 3339. */
	at: string;
	details: AppJsonValue;
	environment?: string;
	name?: string;
	outcome: string;
	path?: string;
	requestId?: string;
	scope?: string;
	scopeId?: string;
	seq: number;
}

export interface VaultAuditVerifyReport {
	firstBadSeq?: number;
	ok: boolean;
	rows: number;
}

export function listVaultAudit(
	target: ApiTarget,
	filter: VaultAuditQuery = {}
): Promise<{ events: VaultAuditEvent[]; nextBefore: number | null }> {
	return request(
		target,
		`/api/vault/audit${query({
			before: filter.before,
			limit: filter.limit,
			name: filter.name,
			action: filter.action,
			actorId: filter.actorId,
			environment: filter.environment,
		})}`,
		{},
		vaultHumanAudit
	);
}

export function verifyVaultAudit(
	target: ApiTarget
): Promise<{ report: VaultAuditVerifyReport }> {
	return request(
		target,
		"/api/vault/audit/verify",
		{},
		vaultHumanAuditVerified
	);
}

// ── Seal, keys, migration ────────────────────────────────────────────────────

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

// ── Transit ──────────────────────────────────────────────────────────────────

export const VAULT_TRANSIT_KEY_TYPES = [
	"aes256-gcm96",
	"chacha20-poly1305",
	"ed25519",
	"ecdsa-p256",
	"ecdsa-p384",
	"rsa-2048",
	"rsa-3072",
	"rsa-4096",
	"hmac",
] as const;

export type KnownVaultTransitKeyType = (typeof VAULT_TRANSIT_KEY_TYPES)[number];

/** Known key types, plus any type a newer server reports. */
export type VaultTransitKeyType =
	| KnownVaultTransitKeyType
	| (string & Record<never, never>);

export interface VaultTransitKey {
	allowPlaintextBackup?: boolean;
	/** `0` disables automatic rotation. */
	autoRotatePeriodSecs?: number;
	convergent?: boolean;
	createdAt: VaultTimestamp;
	/** Set while the key is soft-deleted. */
	deletedAt?: VaultTimestamp;
	deletionAllowed: boolean;
	derived?: boolean;
	exportable?: boolean;
	imported?: boolean;
	latestVersion: number;
	/** Versions below this were trimmed. */
	minAvailableVersion?: number;
	minDecryptionVersion: number;
	/** `0` means any available version may encrypt, sign, or HMAC. */
	minEncryptionVersion?: number;
	name: string;
	/** `[version, public key]` pairs: base64 for Ed25519, SPKI PEM for ECDSA
	 *  and RSA, empty for symmetric and HMAC keys. */
	publicKeys: [number, string][];
	type: VaultTransitKeyType;
}

/** Options shared by encrypt, decrypt, rewrap, sign, verify, and hmac. */
export interface VaultTransitOpOptions {
	/** Base64 associated data authenticated with the ciphertext. */
	associatedData?: string;
	/** Derived keys: the base64 derivation context. */
	context?: string;
	/** Version to encrypt, sign, or HMAC with (default: latest). */
	keyVersion?: number;
	/** RSA signatures: `pss` (default) or `pkcs1v15`. */
	signatureAlgorithm?: string;
}

/** Request and response bodies per transit operation. Plaintext, context, and
 *  input are base64. */
export interface VaultTransitOperations {
	datakey: {
		body: Record<string, never>;
		result: { ciphertext: string; plaintext: string };
	};
	decrypt: {
		body: VaultTransitOpOptions & { ciphertext: string };
		result: { plaintext: string };
	};
	encrypt: {
		body: VaultTransitOpOptions & { plaintext: string };
		result: { ciphertext: string };
	};
	hmac: {
		body: VaultTransitOpOptions & { input: string };
		result: { hmac: string };
	};
	rewrap: {
		body: VaultTransitOpOptions & { ciphertext: string };
		result: { ciphertext: string };
	};
	rotate: { body: Record<string, never>; result: { key: VaultTransitKey } };
	sign: {
		body: VaultTransitOpOptions & { input: string };
		result: { signature: string };
	};
	/** Pass `signature` for a signature or `hmac` for an HMAC. */
	verify: {
		body: VaultTransitOpOptions & {
			hmac?: string;
			input: string;
			signature?: string;
		};
		result: { valid: boolean };
	};
}

export type VaultTransitOperation = keyof VaultTransitOperations;

export function listVaultTransitKeys(
	target: ApiTarget
): Promise<{ keys: VaultTransitKey[] }> {
	return request(target, "/api/vault/transit/keys", {}, vaultHumanTransitKeys);
}

export function createVaultTransitKey(
	target: ApiTarget,
	input: { name: string; type?: VaultTransitKeyType }
): Promise<{ key: VaultTransitKey }> {
	return request(
		target,
		"/api/vault/transit/keys",
		{
			method: "POST",
			body: input,
		},
		vaultHumanTransitKeyResponse
	);
}

export function configureVaultTransitKey(
	target: ApiTarget,
	name: string,
	input: {
		allowPlaintextBackup?: boolean;
		autoRotatePeriodSecs?: number;
		deletionAllowed?: boolean;
		exportable?: boolean;
		minDecryptionVersion?: number;
		minEncryptionVersion?: number;
	}
): Promise<{ key: VaultTransitKey }> {
	return request(
		target,
		`/api/vault/transit/keys/${encodeURIComponent(name)}`,
		{
			method: "PATCH",
			body: input,
		},
		vaultHumanTransitKeyResponse
	);
}

export function deleteVaultTransitKey(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/transit/keys/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

export function vaultTransit<Op extends VaultTransitOperation>(
	target: ApiTarget,
	op: Op,
	name: string,
	body: VaultTransitOperations[Op]["body"]
): Promise<VaultTransitOperations[Op]["result"]> {
	return request(
		target,
		`/api/vault/transit/${op}/${encodeURIComponent(name)}`,
		{
			method: "POST",
			body,
		},
		vaultHumanTransitResponses[op]
	);
}

// ── PKI ──────────────────────────────────────────────────────────────────────

export interface VaultPkiIssuer {
	certificate: string;
	commonName: string;
	name: string;
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	notAfter: VaultTimestamp;
}

export interface VaultPkiRole {
	allowedDomains: string[];
	allowIpSans?: boolean;
	clientFlag?: boolean;
	defaultTtlSecs: number;
	issuer: string;
	maxTtlSecs: number;
	name: string;
	serverFlag?: boolean;
}

export interface VaultPkiIssueInput {
	altNames?: string[];
	commonName: string;
	/** PEM certificate signing request (required for `sign`). */
	csr?: string;
	ipSans?: string[];
	ttlSecs?: number;
}

export interface VaultIssuedCertificate {
	certificate: string;
	issuingCa: string;
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	notAfter: VaultTimestamp;
	/** Returned once for `issue`; never stored. */
	privateKey?: string;
	serial: string;
}

export interface VaultCertRecord {
	commonName: string;
	issuer: string;
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	notAfter: VaultTimestamp;
	revokedAt: VaultTimestamp | null;
	serial: string;
}

export function listVaultPkiIssuers(
	target: ApiTarget
): Promise<{ issuers: VaultPkiIssuer[] }> {
	return request(target, "/api/vault/pki/issuers", {}, vaultHumanPkiIssuers);
}

export function createVaultPkiIssuer(
	target: ApiTarget,
	input: { commonName: string; name: string; ttlSecs?: number }
): Promise<{ issuer: VaultPkiIssuer }> {
	return request(
		target,
		"/api/vault/pki/issuers",
		{
			method: "POST",
			body: input,
		},
		vaultHumanPkiIssuerResponse
	);
}

export function listVaultPkiCertificates(
	target: ApiTarget,
	issuer: string
): Promise<{ certificates: VaultCertRecord[] }> {
	return request(
		target,
		`/api/vault/pki/issuers/${encodeURIComponent(issuer)}/certs`,
		{},
		vaultHumanPkiRecords
	);
}

/** The issuer's current CRL as PEM text (not JSON). */
export async function getVaultPkiCrl(
	target: ApiTarget,
	issuer: string
): Promise<string> {
	const path = `/api/vault/pki/issuers/${encodeURIComponent(issuer)}/crl`;
	const response = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	const text = await response.text();
	if (!response.ok) {
		throw apiErrorFromBody(path, response.status, text);
	}
	return text;
}

export function listVaultPkiRoles(
	target: ApiTarget
): Promise<{ roles: VaultPkiRole[] }> {
	return request(target, "/api/vault/pki/roles", {}, vaultHumanPkiRoles);
}

export function putVaultPkiRole(
	target: ApiTarget,
	name: string,
	role: Omit<VaultPkiRole, "name">
): Promise<{ role: VaultPkiRole }> {
	return request(
		target,
		`/api/vault/pki/roles/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			body: role,
		},
		vaultHumanPkiRoleResponse
	);
}

export function deleteVaultPkiRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/pki/roles/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

/** `issue` mints a key pair; `sign` signs `input.csr`. */
export function vaultPki(
	target: ApiTarget,
	op: "issue" | "sign",
	role: string,
	input: VaultPkiIssueInput
): Promise<{ certificate: VaultIssuedCertificate }> {
	return request(
		target,
		`/api/vault/pki/${op}/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: input,
		},
		vaultMachinePkiResponse
	);
}

export function revokeVaultPkiCertificate(
	target: ApiTarget,
	serial: string
): Promise<{ certificate: VaultCertRecord }> {
	return request(
		target,
		"/api/vault/pki/revoke",
		{
			method: "POST",
			body: { serial },
		},
		vaultHumanPkiRecordResponse
	);
}

// ── SSH ──────────────────────────────────────────────────────────────────────

export interface VaultSshRole {
	allowedPrincipals: string[];
	ca: string;
	certType: "user" | "host";
	defaultTtlSecs: number;
	extensions?: string[];
	maxTtlSecs: number;
	name: string;
}

export interface VaultSshSignInput {
	keyId?: string;
	principals?: string[];
	publicKey: string;
	ttlSecs?: number;
}

export interface VaultSshCertificate {
	certificate: string;
	keyId: string;
	principals: string[];
	serial: number;
	/** RFC 3339 after rendering, or a raw epoch-second fallback. */
	validAfter: VaultTimestamp;
	/** RFC 3339 after rendering, or a raw epoch-second fallback. */
	validBefore: VaultTimestamp;
}

export function listVaultSshCas(
	target: ApiTarget
): Promise<{ cas: Array<{ name: string; publicKey: string }> }> {
	return request(target, "/api/vault/ssh/cas", {}, vaultHumanSshCas);
}

export function createVaultSshCa(
	target: ApiTarget,
	name: string
): Promise<{ publicKey: string }> {
	return request(
		target,
		"/api/vault/ssh/cas",
		{
			method: "POST",
			body: { name },
		},
		vaultHumanSshPublicKey
	);
}

export function listVaultSshRoles(
	target: ApiTarget
): Promise<{ roles: VaultSshRole[] }> {
	return request(target, "/api/vault/ssh/roles", {}, vaultHumanSshRoles);
}

export function putVaultSshRole(
	target: ApiTarget,
	name: string,
	role: Omit<VaultSshRole, "name">
): Promise<{ role: VaultSshRole }> {
	return request(
		target,
		`/api/vault/ssh/roles/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			body: role,
		},
		vaultHumanSshRoleResponse
	);
}

export function deleteVaultSshRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/ssh/roles/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

export function signVaultSshKey(
	target: ApiTarget,
	role: string,
	input: VaultSshSignInput
): Promise<{ certificate: VaultSshCertificate }> {
	return request(
		target,
		`/api/vault/ssh/sign/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: input,
		},
		vaultMachineSshResponse
	);
}

// ── Dynamic secrets and leases ───────────────────────────────────────────────

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

// ── Machine identities ───────────────────────────────────────────────────────

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

// ── Machine login and agent routes (public, token-authenticated) ─────────────

/** A node URL for the public machine routes. No node bearer is ever sent. */
export interface VaultMachineTarget {
	fetch?: RyuFetch;
	url: string;
}

/** A machine target holding a vault token for `/api/vault/agent/*`. */
export interface VaultAgentTarget extends VaultMachineTarget {
	vaultToken: string;
}

export interface VaultIssuedToken {
	accessor: string;
	expiresAt: string | number;
	identityId: string;
	policies: string[];
	/** The `rvt_…` token, shown once. */
	token: string;
}

export interface VaultTokenPrincipal {
	accessor: string;
	expiresAt: string | number;
	identityId: string;
	identityName: string;
	policies: string[];
}

// These codecs own complete machine reply fields only after native JSON.parse.
// Validation retains the decoded record, including future keys and nested references.
function vaultMachineCodec<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const vaultMachineText = z.string();
const vaultMachineNumber = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const vaultMachineDate = z.union([vaultMachineText, vaultMachineNumber]);
const vaultMachineStringsFields = z.record(z.string(), vaultMachineText);
const vaultMachineStrings = z.custom<
	z.output<typeof vaultMachineStringsFields>
>(
	(value) =>
		vaultMachineStringsFields.safeParse(value).success &&
		Object.entries(Object.call(undefined, value)).every(
			([, entry]) => vaultMachineText.safeParse(entry).success
		)
);
const vaultMachineIssuedToken = vaultMachineCodec(
	z.object({
		token: vaultMachineText,
		accessor: vaultMachineText,
		identityId: vaultMachineText,
		policies: z.array(vaultMachineText),
		expiresAt: vaultMachineDate,
	})
);
const vaultMachinePrincipal = vaultMachineCodec(
	z.object({
		accessor: vaultMachineText,
		identityId: vaultMachineText,
		identityName: vaultMachineText,
		policies: z.array(vaultMachineText),
		expiresAt: vaultMachineDate,
	})
);
const vaultMachineLease = vaultMachineCodec(
	z.object({
		id: vaultMachineText,
		role: vaultMachineText,
		provider: vaultMachineText,
		issuedTo: vaultMachineText.nullable(),
		createdAt: vaultMachineDate,
		expiresAt: vaultMachineDate,
		maxExpiresAt: vaultMachineDate,
		renewable: z.boolean(),
		revokedAt: vaultMachineDate.nullable(),
	})
);
const vaultMachineLoginResponse = vaultMachineCodec(
	z.object({ token: vaultMachineIssuedToken })
);
const vaultMachineSelfResponse = vaultMachineCodec(
	z.object({ token: vaultMachinePrincipal })
);
const vaultMachineRevokedResponse = vaultMachineCodec(
	z.object({ revoked: z.boolean() })
);
const vaultMachineExportResponse = vaultMachineCodec(
	z.object({
		content: vaultMachineText,
		contentType: vaultMachineText,
		count: vaultMachineNumber,
		environment: vaultMachineText,
		format: z.enum(["dotenv", "json", "yaml", "shell", "k8s-secret"]),
		path: vaultMachineText,
		sharedError: vaultMachineText.nullish(),
	})
);
const vaultMachineValueResponse = vaultMachineCodec(
	z.object({ value: vaultMachineText })
);
const vaultMachineDynamicResponse = vaultMachineCodec(
	z.object({
		credential: vaultMachineCodec(
			z.object({ data: vaultMachineStrings, lease: vaultMachineLease })
		),
	})
);
const vaultMachineLeaseResponse = vaultMachineCodec(
	z.object({ lease: vaultMachineLease })
);
const vaultMachinePkiResponse = vaultMachineCodec(
	z.object({
		certificate: vaultMachineCodec(
			z.object({
				certificate: vaultMachineText,
				issuingCa: vaultMachineText,
				notAfter: vaultMachineDate,
				privateKey: vaultMachineText.optional(),
				serial: vaultMachineText,
			})
		),
	})
);
const vaultMachineSshResponse = vaultMachineCodec(
	z.object({
		certificate: vaultMachineCodec(
			z.object({
				certificate: vaultMachineText,
				keyId: vaultMachineText,
				principals: z.array(vaultMachineText),
				serial: vaultMachineNumber,
				validAfter: vaultMachineDate,
				validBefore: vaultMachineDate,
			})
		),
	})
);
type VaultMachineTransitCodecs = {
	[Op in Exclude<VaultTransitOperation, "rotate">]: z.ZodType<
		VaultTransitOperations[Op]["result"]
	>;
};
const vaultMachineTransitResponses: VaultMachineTransitCodecs = {
	datakey: vaultMachineCodec(
		z.object({ ciphertext: vaultMachineText, plaintext: vaultMachineText })
	),
	decrypt: vaultMachineCodec(z.object({ plaintext: vaultMachineText })),
	encrypt: vaultMachineCodec(z.object({ ciphertext: vaultMachineText })),
	hmac: vaultMachineCodec(z.object({ hmac: vaultMachineText })),
	rewrap: vaultMachineCodec(z.object({ ciphertext: vaultMachineText })),
	sign: vaultMachineCodec(z.object({ signature: vaultMachineText })),
	verify: vaultMachineCodec(z.object({ valid: z.boolean() })),
};

async function machineRequest<T>(
	schema: z.ZodType<T>,
	target: VaultMachineTarget,
	path: string,
	options: {
		body?: unknown;
		headers?: VaultMachineHeaders;
		method?: string;
		vaultToken?: string;
	} = {}
): Promise<T> {
	const headers: VaultMachineHeaders = {
		...options.headers,
		"Content-Type": "application/json",
	};
	if (options.vaultToken) {
		headers[VAULT_TOKEN_HEADER] = options.vaultToken;
	}
	const base = target.url.replace(/\/$/, "");
	const response = await fetchForTarget(target)(`${base}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw apiErrorFromBody(path, response.status, text);
	}
	return schema.parse(text ? JSON.parse(text) : undefined);
}

function agentRequest<T>(
	schema: z.ZodType<T>,
	target: VaultAgentTarget,
	path: string,
	options: {
		body?: unknown;
		headers?: VaultMachineHeaders;
		method?: string;
	} = {}
): Promise<T> {
	return machineRequest(schema, target, path, {
		...options,
		vaultToken: target.vaultToken,
	});
}

/** Exchange an AppRole role id and secret id for a short-lived vault token. */
export function vaultAppRoleLogin(
	target: VaultMachineTarget,
	input: { roleId: string; secretId: string }
): Promise<{ token: VaultIssuedToken }> {
	return machineRequest(
		vaultMachineLoginResponse,
		target,
		"/api/vault/auth/approle/login",
		{
			method: "POST",
			body: input,
		}
	);
}

/** Exchange an OIDC JWT (for example a GitHub Actions ID token) for a vault token. */
export function vaultJwtLogin(
	target: VaultMachineTarget,
	input: { identity: string; jwt: string }
): Promise<{ token: VaultIssuedToken }> {
	return machineRequest(
		vaultMachineLoginResponse,
		target,
		"/api/vault/auth/jwt/login",
		{
			method: "POST",
			body: input,
		}
	);
}

export function vaultAgentSelf(
	target: VaultAgentTarget
): Promise<{ token: VaultTokenPrincipal }> {
	return agentRequest(
		vaultMachineSelfResponse,
		target,
		"/api/vault/agent/self"
	);
}

export function vaultAgentRevokeSelf(
	target: VaultAgentTarget
): Promise<{ revoked: boolean }> {
	return agentRequest(
		vaultMachineRevokedResponse,
		target,
		"/api/vault/agent/self/revoke",
		{
			method: "POST",
		}
	);
}

/** Export node-scoped values the token may read. Kubernetes naming options are
 *  not accepted on this route. */
export function vaultAgentExport(
	target: VaultAgentTarget,
	input: Omit<VaultExportInput, "k8sName" | "k8sNamespace"> = {}
): Promise<VaultExportResult> {
	return agentRequest(
		vaultMachineExportResponse,
		target,
		"/api/vault/agent/export",
		{
			method: "POST",
			body: input,
		}
	);
}

/** Read one node-scoped value with a machine token. */
export function vaultAgentSecret(
	target: VaultAgentTarget,
	name: string,
	location: { environment?: string; path?: string } = {}
): Promise<{ value: string }> {
	return agentRequest(
		vaultMachineValueResponse,
		target,
		`/api/vault/agent/secrets/${encodeURIComponent(name)}${query(location)}`
	);
}

export function vaultAgentDynamicIssue(
	target: VaultAgentTarget,
	role: string,
	ttlSecs?: number
): Promise<z.output<typeof vaultMachineDynamicResponse>> {
	return agentRequest(
		vaultMachineDynamicResponse,
		target,
		`/api/vault/agent/dynamic/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: ttlSecs === undefined ? {} : { ttlSecs },
		}
	);
}

export function vaultAgentLease(
	target: VaultAgentTarget,
	id: string,
	op: "renew" | "revoke",
	ttlSecs?: number
): Promise<z.output<typeof vaultMachineLeaseResponse>> {
	return agentRequest(
		vaultMachineLeaseResponse,
		target,
		`/api/vault/agent/leases/${encodeURIComponent(id)}/${op}`,
		{
			method: "POST",
			body: ttlSecs === undefined ? {} : { ttlSecs },
		}
	);
}

export function vaultAgentTransit<
	Op extends Exclude<VaultTransitOperation, "rotate">,
>(
	target: VaultAgentTarget,
	op: Op,
	name: string,
	body: VaultTransitOperations[Op]["body"]
): Promise<VaultTransitOperations[Op]["result"]> {
	return agentRequest(
		vaultMachineTransitResponses[op],
		target,
		`/api/vault/agent/transit/${op}/${encodeURIComponent(name)}`,
		{ method: "POST", body }
	);
}

export function vaultAgentPki(
	target: VaultAgentTarget,
	op: "issue" | "sign",
	role: string,
	input: VaultPkiIssueInput
): Promise<z.output<typeof vaultMachinePkiResponse>> {
	return agentRequest(
		vaultMachinePkiResponse,
		target,
		`/api/vault/agent/pki/${op}/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: input,
		}
	);
}

export function vaultAgentSshSign(
	target: VaultAgentTarget,
	role: string,
	input: VaultSshSignInput
): Promise<z.output<typeof vaultMachineSshResponse>> {
	return agentRequest(
		vaultMachineSshResponse,
		target,
		`/api/vault/agent/ssh/sign/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: input,
		}
	);
}

// ── Reply codecs for the broker, TOTP, item, and token surfaces ──────────────

// Each codec validates the fields the CLI and Desktop read and retains the
// complete decoded object, like the machine codecs above.
function vaultReply<T>(fields: z.ZodType): z.ZodType<T> {
	return z.custom<T>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const vaultText = z.string();
const vaultDate = vaultMachineDate;
const vaultNumber = vaultMachineNumber;
const vaultFlag = z.object({}).catchall(z.union([z.boolean(), vaultText]));

function locationQuery(location: VaultItemLocation = {}): string {
	return query({ environment: location.environment, path: location.path });
}

// ── Credential broker ────────────────────────────────────────────────────────

export interface VaultBrokerStatus {
	caUrl: string;
	listening: boolean;
	port: number | null;
	portEnv: string;
}

/** A brokered upstream. `auth` and `substitutions` keep Core's serde shape. */
export interface VaultBrokerService {
	allowInsecureHttp?: boolean;
	auth: AppJsonValue;
	createdAt: VaultTimestamp;
	description?: string;
	enabled: boolean;
	environment: string;
	host: string;
	name: string;
	notes?: string;
	pathPrefix: string;
	port?: number;
	substitutions?: AppJsonValue[];
	updatedAt: VaultTimestamp;
}

export interface VaultBrokerSession {
	createdAt: VaultTimestamp;
	environment: string;
	expiresAt: VaultTimestamp;
	id: string;
	label: string;
	mintedBy: string;
	revokedAt?: VaultTimestamp;
	services: string[];
}

/** The child-process proxy environment; `null` when the listener is down. */
export interface VaultBrokerProxy {
	caBundlePath: string;
	caPath: string;
	caUrl: string;
	env: Record<string, string>;
	port: number;
	url: string;
}

/** A minted session. `token` is shown once and is also embedded in `proxy.env`. */
export interface VaultBrokerSessionGrant {
	proxy: VaultBrokerProxy | null;
	session: VaultBrokerSession;
	token: string;
}

export interface VaultBrokerSessionInput {
	environment?: string;
	label?: string;
	services: string[];
	ttlSecs?: number;
}

export interface VaultBrokerLogRow {
	at: VaultTimestamp;
	environment: string;
	host: string;
	id: number;
	latencyMs: number;
	method: string;
	outcome: string;
	path: string;
	port: number;
	scheme: string;
	service: string | null;
	sessionId: string | null;
	status: number;
}

export interface VaultBrokerLogFilter {
	before?: number;
	environment?: string;
	limit?: number;
	service?: string;
	sessionId?: string;
	statusBucket?: "2xx" | "3xx" | "4xx" | "5xx";
}

export interface VaultBrokerDiscoveredHost {
	environment: string;
	host: string;
	lastSeen: VaultTimestamp;
	port: number;
	requests: number;
	suggestedTemplate?: string;
}

export type VaultBrokerProposalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "expired";

export interface VaultBrokerCredentialRequest {
	description: string;
	obtainInstructions: string;
	ref: string;
}

export interface VaultBrokerProposal {
	createdAt: VaultTimestamp;
	credentials: VaultBrokerCredentialRequest[];
	/** Set on a password-manager credential-use request (no services or
	 *  credentials). */
	credentialUse?: VaultCredentialUse;
	decidedAt?: VaultTimestamp;
	decidedBy?: string;
	environment: string;
	expiresAt: VaultTimestamp;
	id: string;
	message: string;
	note?: string;
	requestedBy: string;
	services: AppJsonValue[];
	status: VaultBrokerProposalStatus;
}

export interface VaultBrokerDecisionInput {
	/** Approve only, for a password-manager credential-use request: how long
	 *  the grant lasts (Core defaults to `30d`). */
	grant?: VaultPasswordManagerGrantMode;
	note?: string;
	/** Approve only: values for requested credentials, keyed by `secret:` reference. */
	values?: Record<string, string>;
}

export interface VaultBrokerDiscovery {
	environment: string;
	proposalsEndpoint: string;
	proxy: VaultBrokerStatus;
	services: AppJsonValue[];
	skills: AppJsonValue;
	unmatchedHostPolicy: AppJsonValue;
}

const vaultBrokerStatusFields = z.object({
	listening: z.boolean(),
	port: vaultNumber.nullable(),
	caUrl: vaultText,
	portEnv: vaultText,
});
const vaultBrokerServiceFields = z.object({
	name: vaultText,
	environment: vaultText,
	host: vaultText,
	pathPrefix: vaultText,
	enabled: z.boolean(),
	auth: appJsonValueSchema,
	createdAt: vaultDate,
	updatedAt: vaultDate,
});
const vaultBrokerSessionFields = z.object({
	id: vaultText,
	environment: vaultText,
	services: z.array(vaultText),
	label: vaultText,
	mintedBy: vaultText,
	createdAt: vaultDate,
	expiresAt: vaultDate,
});
const vaultBrokerProposalFields = z.object({
	id: vaultText,
	environment: vaultText,
	status: z.enum(["pending", "approved", "rejected", "expired"]),
	message: vaultText,
	services: z.array(appJsonValueSchema),
	credentials: z.array(z.object({ ref: vaultText })),
	requestedBy: vaultText,
	createdAt: vaultDate,
	expiresAt: vaultDate,
});
const vaultBrokerGrantFields = z.object({
	token: vaultText,
	session: vaultBrokerSessionFields,
	proxy: z
		.object({
			url: vaultText,
			port: vaultNumber,
			caPath: vaultText,
			caBundlePath: vaultText,
			caUrl: vaultText,
			env: z.record(z.string(), vaultText),
		})
		.nullable(),
});
const vaultBrokerStatusReply = vaultReply<{ broker: VaultBrokerStatus }>(
	z.object({ broker: vaultBrokerStatusFields })
);
const vaultBrokerCatalogReply = vaultReply<{ templates: AppJsonValue[] }>(
	z.object({ templates: z.array(appJsonValueSchema) })
);
const vaultBrokerServicesReply = vaultReply<{ services: VaultBrokerService[] }>(
	z.object({ services: z.array(vaultBrokerServiceFields) })
);
const vaultBrokerServiceReply = vaultReply<{ service: VaultBrokerService }>(
	z.object({ service: vaultBrokerServiceFields })
);
const vaultBrokerGrantReply = vaultReply<VaultBrokerSessionGrant>(
	vaultBrokerGrantFields
);
const vaultBrokerSessionsReply = vaultReply<{
	sessions: VaultBrokerSession[];
}>(z.object({ sessions: z.array(vaultBrokerSessionFields) }));
const vaultBrokerLogsReply = vaultReply<{ logs: VaultBrokerLogRow[] }>(
	z.object({
		logs: z.array(
			z.object({
				id: vaultNumber,
				at: vaultDate,
				method: vaultText,
				host: vaultText,
				path: vaultText,
				status: vaultNumber,
				outcome: vaultText,
			})
		),
	})
);
const vaultBrokerHostsReply = vaultReply<{
	hosts: VaultBrokerDiscoveredHost[];
}>(
	z.object({
		hosts: z.array(
			z.object({ host: vaultText, port: vaultNumber, requests: vaultNumber })
		),
	})
);
const vaultBrokerProposalsReply = vaultReply<{
	proposals: VaultBrokerProposal[];
}>(z.object({ proposals: z.array(vaultBrokerProposalFields) }));
const vaultBrokerProposalReply = vaultReply<{ proposal: VaultBrokerProposal }>(
	z.object({ proposal: vaultBrokerProposalFields })
);
const vaultBrokerDecisionReply = vaultReply<
	{ approved: true; proposal: string } | { rejected: true }
>(vaultFlag);
const vaultBrokerDiscoveryReply = vaultReply<VaultBrokerDiscovery>(
	z.object({
		environment: vaultText,
		services: z.array(appJsonValueSchema),
		proxy: vaultBrokerStatusFields,
		proposalsEndpoint: vaultText,
	})
);
const vaultDeletedReply = vaultReply<{ deleted: boolean }>(
	z.object({ deleted: z.boolean() })
);

function brokerPath(suffix: string): string {
	return `/api/vault/broker${suffix}`;
}

export function getVaultBrokerStatus(
	target: ApiTarget
): Promise<{ broker: VaultBrokerStatus }> {
	return request(target, brokerPath("/status"), {}, vaultBrokerStatusReply);
}

export function listVaultBrokerCatalog(
	target: ApiTarget
): Promise<{ templates: AppJsonValue[] }> {
	return request(target, brokerPath("/catalog"), {}, vaultBrokerCatalogReply);
}

export function listVaultBrokerServices(
	target: ApiTarget,
	filter: { environment?: string } = {}
): Promise<{ services: VaultBrokerService[] }> {
	return request(
		target,
		brokerPath(`/services${query({ environment: filter.environment })}`),
		{},
		vaultBrokerServicesReply
	);
}

export function getVaultBrokerService(
	target: ApiTarget,
	name: string
): Promise<{ service: VaultBrokerService }> {
	return request(
		target,
		brokerPath(`/services/${encodeURIComponent(name)}`),
		{},
		vaultBrokerServiceReply
	);
}

/** Create a service from a full definition or `{ template, name?, environment?,
 *  credentialRef? }` for a catalog template. */
export function createVaultBrokerService(
	target: ApiTarget,
	input: Record<string, AppJsonValue>
): Promise<{ service: VaultBrokerService }> {
	return request(
		target,
		brokerPath("/services"),
		{ method: "POST", body: input },
		vaultBrokerServiceReply
	);
}

export function putVaultBrokerService(
	target: ApiTarget,
	name: string,
	input: Record<string, AppJsonValue>
): Promise<{ service: VaultBrokerService }> {
	return request(
		target,
		brokerPath(`/services/${encodeURIComponent(name)}`),
		{ method: "PUT", body: input },
		vaultBrokerServiceReply
	);
}

export function deleteVaultBrokerService(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		brokerPath(`/services/${encodeURIComponent(name)}`),
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** Mint a broker session (`use` on each `sys/broker/<service>`). */
export function createVaultBrokerSession(
	target: ApiTarget,
	input: VaultBrokerSessionInput
): Promise<VaultBrokerSessionGrant> {
	return request(
		target,
		brokerPath("/sessions"),
		{ method: "POST", body: input },
		vaultBrokerGrantReply
	);
}

export function listVaultBrokerSessions(
	target: ApiTarget
): Promise<{ sessions: VaultBrokerSession[] }> {
	return request(target, brokerPath("/sessions"), {}, vaultBrokerSessionsReply);
}

export function revokeVaultBrokerSession(
	target: ApiTarget,
	id: string
): Promise<{ revoked: boolean }> {
	return request(
		target,
		brokerPath(`/sessions/${encodeURIComponent(id)}`),
		{ method: "DELETE" },
		vaultMachineRevokedResponse
	);
}

/** The broker CA certificate as PEM text (a public route; 404 before the
 *  first session is minted). */
export async function getVaultBrokerCaPem(
	target: VaultMachineTarget
): Promise<string> {
	const path = brokerPath("/ca.pem");
	const base = target.url.replace(/\/$/, "");
	const response = await fetchForTarget(target)(`${base}${path}`, {
		method: "GET",
	});
	const text = await response.text();
	if (!response.ok) {
		throw apiErrorFromBody(path, response.status, text);
	}
	return text;
}

export function listVaultBrokerLogs(
	target: ApiTarget,
	filter: VaultBrokerLogFilter = {}
): Promise<{ logs: VaultBrokerLogRow[] }> {
	return request(
		target,
		brokerPath(
			`/logs${query({
				environment: filter.environment,
				service: filter.service,
				sessionId: filter.sessionId,
				statusBucket: filter.statusBucket,
				before: filter.before,
				limit: filter.limit,
			})}`
		),
		{},
		vaultBrokerLogsReply
	);
}

export function listVaultBrokerDiscoveredHosts(
	target: ApiTarget,
	filter: { environment?: string } = {}
): Promise<{ hosts: VaultBrokerDiscoveredHost[] }> {
	return request(
		target,
		brokerPath(
			`/discovered-hosts${query({ environment: filter.environment })}`
		),
		{},
		vaultBrokerHostsReply
	);
}

export function listVaultBrokerProposals(
	target: ApiTarget,
	filter: { status?: VaultBrokerProposalStatus } = {}
): Promise<{ proposals: VaultBrokerProposal[] }> {
	return request(
		target,
		brokerPath(`/proposals${query({ status: filter.status })}`),
		{},
		vaultBrokerProposalsReply
	);
}

/** Approve (optionally supplying requested credential values) or reject an
 *  agent proposal. Needs `admin` on `sys/broker`. */
export function decideVaultBrokerProposal(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject",
	input: VaultBrokerDecisionInput = {}
): Promise<{ approved: true; proposal: string } | { rejected: true }> {
	const body: VaultBrokerDecisionInput = {};
	if (input.note) {
		body.note = input.note;
	}
	if (decision === "approve" && input.values) {
		body.values = input.values;
	}
	if (decision === "approve" && input.grant) {
		body.grant = input.grant;
	}
	return request(
		target,
		brokerPath(`/proposals/${encodeURIComponent(id)}/${decision}`),
		{ method: "POST", body },
		vaultBrokerDecisionReply
	);
}

// ── Password-manager credentials ─────────────────────────────────────────────

export type VaultPasswordManagerProvider =
	| "1password-connect"
	| "1password-service-account"
	| "bitwarden-sm";

export type VaultPasswordManagerState = "connected" | "reconnect_required";

/** `once` is one use within a day; the others are lifetimes. */
export type VaultPasswordManagerGrantMode = "once" | "1h" | "24h" | "30d";

/** The first use of an `op://` / `bws://` reference by one consumer. */
export interface VaultCredentialUse {
	account: string;
	accountId: string;
	provider: VaultPasswordManagerProvider;
	ref: string;
	/** The consumer, scoped to its channel: `broker:<minter>`,
	 *  `runtime:<mcp>:<owner>`, or `read:<principal>`. */
	subject: string;
}

/** A password-manager account. Core never returns its token. */
export interface VaultPasswordManagerAccount {
	address: string | null;
	binaryPath: string | null;
	createdAt: VaultTimestamp;
	id: string;
	lastCheckedAt: VaultTimestamp | null;
	lastError: string | null;
	name: string;
	provider: VaultPasswordManagerProvider;
	state: VaultPasswordManagerState;
	updatedAt: VaultTimestamp;
}

export interface VaultPasswordManagerAccountInput {
	/** Connect server URL (required for `1password-connect`), or a Bitwarden
	 *  self-hosted server URL. */
	address?: string;
	name: string;
	provider: VaultPasswordManagerProvider;
	token: string;
}

export interface VaultPasswordManagerGrant {
	account: string;
	accountId: string;
	createdAt: VaultTimestamp;
	expiresAt: VaultTimestamp;
	grantedBy: string;
	id: string;
	mode: VaultPasswordManagerGrantMode;
	proposalId: string | null;
	ref: string;
	revokedAt: VaultTimestamp | null;
	subject: string;
	usesRemaining: number | null;
}

export interface VaultPasswordManagerTestResult {
	account: VaultPasswordManagerAccount | null;
	error?: string;
	ok: boolean;
}

/** `200` with the value, or `202` while the caller's use awaits approval
 *  (the provider was not contacted). */
export type VaultPasswordManagerReadResult =
	| {
			account: string;
			pending?: undefined;
			provider: VaultPasswordManagerProvider;
			ref: string;
			value: string;
	  }
	| { approval: VaultBrokerProposal; pending: true };

export interface VaultPasswordManagerDecisionInput {
	/** Approve only (Core defaults to `30d`). */
	grant?: VaultPasswordManagerGrantMode;
	note?: string;
}

const vaultPmProviderField = z.enum([
	"1password-connect",
	"1password-service-account",
	"bitwarden-sm",
]);
const vaultPmAccountFields = z.object({
	id: vaultText,
	name: vaultText,
	provider: vaultPmProviderField,
	state: z.enum(["connected", "reconnect_required"]),
	address: vaultText.nullable(),
	createdAt: vaultDate,
});
const vaultPmGrantFields = z.object({
	id: vaultText,
	subject: vaultText,
	account: vaultText,
	ref: vaultText,
	mode: z.enum(["once", "1h", "24h", "30d"]),
	expiresAt: vaultDate,
});
const vaultPmApprovalFields = vaultBrokerProposalFields.extend({
	credentialUse: z.object({
		ref: vaultText,
		account: vaultText,
		provider: vaultPmProviderField,
		subject: vaultText,
	}),
});
const vaultPmAccountsReply = vaultReply<{
	accounts: VaultPasswordManagerAccount[];
}>(z.object({ accounts: z.array(vaultPmAccountFields) }));
const vaultPmAccountReply = vaultReply<{
	account: VaultPasswordManagerAccount;
}>(z.object({ account: vaultPmAccountFields }));
const vaultPmTestReply = vaultReply<VaultPasswordManagerTestResult>(
	z.object({ ok: z.boolean(), account: vaultPmAccountFields.nullable() })
);
const vaultPmReadReply = vaultReply<VaultPasswordManagerReadResult>(
	z.union([
		z.object({
			value: vaultText,
			ref: vaultText,
			account: vaultText,
			provider: vaultPmProviderField,
		}),
		z.object({ pending: z.literal(true), approval: vaultPmApprovalFields }),
	])
);
const vaultPmGrantsReply = vaultReply<{
	grants: VaultPasswordManagerGrant[];
}>(z.object({ grants: z.array(vaultPmGrantFields) }));
const vaultPmRevokeReply = vaultReply<{
	grant: VaultPasswordManagerGrant;
	revoked: true;
}>(z.object({ revoked: z.literal(true), grant: vaultPmGrantFields }));
const vaultPmApprovalsReply = vaultReply<{
	approvals: VaultBrokerProposal[];
}>(z.object({ approvals: z.array(vaultPmApprovalFields) }));
const vaultPmDecisionReply = vaultReply<
	| { approved: true; grant: VaultPasswordManagerGrant; proposal: string }
	| { rejected: true }
>(
	z.union([
		z.object({
			approved: z.literal(true),
			proposal: vaultText,
			grant: vaultPmGrantFields,
		}),
		z.object({ rejected: z.literal(true) }),
	])
);

function pmPath(suffix: string): string {
	return `/api/vault/password-managers${suffix}`;
}

/** Password-manager accounts visible to the caller (never tokens). */
export function listVaultPasswordManagerAccounts(
	target: ApiTarget
): Promise<{ accounts: VaultPasswordManagerAccount[] }> {
	return request(target, pmPath("/accounts"), {}, vaultPmAccountsReply);
}

/** Add a 1Password or Bitwarden Secrets Manager account; Core seals the
 *  token and never returns it. Needs `admin` on
 *  `sys/password-managers/<name>`. */
export function createVaultPasswordManagerAccount(
	target: ApiTarget,
	input: VaultPasswordManagerAccountInput
): Promise<{ account: VaultPasswordManagerAccount }> {
	const body: Record<string, string> = {
		name: input.name,
		provider: input.provider,
		token: input.token,
	};
	if (input.address) {
		body.address = input.address;
	}
	return request(
		target,
		pmPath("/accounts"),
		{ method: "POST", body },
		vaultPmAccountReply
	);
}

export function deleteVaultPasswordManagerAccount(
	target: ApiTarget,
	id: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		pmPath(`/accounts/${encodeURIComponent(id)}`),
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** Check connectivity and the token without reading a value. A provider
 *  failure answers `ok: false` with a sanitized error. */
export function testVaultPasswordManagerAccount(
	target: ApiTarget,
	id: string
): Promise<VaultPasswordManagerTestResult> {
	return request(
		target,
		pmPath(`/accounts/${encodeURIComponent(id)}/test`),
		{ method: "POST" },
		vaultPmTestReply
	);
}

/** Replace an account's token (reconnect). */
export function setVaultPasswordManagerToken(
	target: ApiTarget,
	id: string,
	token: string
): Promise<{ account: VaultPasswordManagerAccount }> {
	return request(
		target,
		pmPath(`/accounts/${encodeURIComponent(id)}/token`),
		{ method: "POST", body: { token } },
		vaultPmAccountReply
	);
}

/** Read an `op://` or `bws://` reference as the calling human. The first
 *  read files an approval request and answers `pending`. */
export function readVaultPasswordManagerRef(
	target: ApiTarget,
	ref: string,
	options: { environment?: string } = {}
): Promise<VaultPasswordManagerReadResult> {
	const body: Record<string, string> = { ref };
	if (options.environment) {
		body.environment = options.environment;
	}
	return request(
		target,
		pmPath("/read"),
		{ method: "POST", body },
		vaultPmReadReply
	);
}

export function listVaultPasswordManagerGrants(
	target: ApiTarget,
	filter: { all?: boolean } = {}
): Promise<{ grants: VaultPasswordManagerGrant[] }> {
	return request(
		target,
		pmPath(`/grants${query({ all: filter.all ? "true" : undefined })}`),
		{},
		vaultPmGrantsReply
	);
}

export function revokeVaultPasswordManagerGrant(
	target: ApiTarget,
	id: string
): Promise<{ grant: VaultPasswordManagerGrant; revoked: true }> {
	return request(
		target,
		pmPath(`/grants/${encodeURIComponent(id)}`),
		{ method: "DELETE" },
		vaultPmRevokeReply
	);
}

/** Credential-use requests (pending by default). */
export function listVaultPasswordManagerApprovals(
	target: ApiTarget,
	filter: { status?: VaultBrokerProposalStatus } = {}
): Promise<{ approvals: VaultBrokerProposal[] }> {
	return request(
		target,
		pmPath(`/approvals${query({ status: filter.status })}`),
		{},
		vaultPmApprovalsReply
	);
}

/** Approve (with a grant lifetime) or reject a credential-use request.
 *  Needs `admin` on the account. */
export function decideVaultPasswordManagerApproval(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject",
	input: VaultPasswordManagerDecisionInput = {}
): Promise<
	| { approved: true; grant: VaultPasswordManagerGrant; proposal: string }
	| { rejected: true }
> {
	const body: VaultPasswordManagerDecisionInput = {};
	if (input.note) {
		body.note = input.note;
	}
	if (decision === "approve" && input.grant) {
		body.grant = input.grant;
	}
	return request(
		target,
		pmPath(`/approvals/${encodeURIComponent(id)}/${decision}`),
		{ method: "POST", body },
		vaultPmDecisionReply
	);
}

/** Mint a broker session with a machine token; it lives no longer than the token. */
export function vaultAgentBrokerSession(
	target: VaultAgentTarget,
	input: VaultBrokerSessionInput
): Promise<VaultBrokerSessionGrant> {
	return agentRequest(
		vaultBrokerGrantReply,
		target,
		"/api/vault/agent/broker/sessions",
		{ method: "POST", body: input }
	);
}

/** Services and placeholders the token (or broker session) may use. Never values. */
export function vaultAgentBrokerDiscover(
	target: VaultAgentTarget,
	filter: { environment?: string } = {}
): Promise<VaultBrokerDiscovery> {
	return agentRequest(
		vaultBrokerDiscoveryReply,
		target,
		`/api/vault/agent/broker/discover${query({ environment: filter.environment })}`
	);
}

/** Propose services or credentials for a human to approve. */
export function vaultAgentBrokerPropose(
	target: VaultAgentTarget,
	input: {
		credentials?: Partial<VaultBrokerCredentialRequest>[];
		environment?: string;
		message?: string;
		services?: Record<string, AppJsonValue>[];
	}
): Promise<{ proposal: VaultBrokerProposal }> {
	return agentRequest(
		vaultBrokerProposalReply,
		target,
		"/api/vault/agent/broker/proposals",
		{ method: "POST", body: input }
	);
}

export function vaultAgentBrokerProposal(
	target: VaultAgentTarget,
	id: string
): Promise<{ proposal: VaultBrokerProposal }> {
	return agentRequest(
		vaultBrokerProposalReply,
		target,
		`/api/vault/agent/broker/proposals/${encodeURIComponent(id)}`
	);
}

// ── TOTP and password policies ───────────────────────────────────────────────

export type VaultTotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface VaultTotpKey {
	account: string;
	algorithm: VaultTotpAlgorithm;
	createdAt: VaultTimestamp;
	digits: number;
	generated: boolean;
	issuer: string;
	name: string;
	period: number;
	skew: number;
}

/** Exactly one of `generate`, `url` (otpauth://totp/…), or `secret` (Base32). */
export interface VaultTotpCreateInput {
	account?: string;
	algorithm?: VaultTotpAlgorithm;
	digits?: number;
	exported?: boolean;
	generate?: boolean;
	issuer?: string;
	keySize?: number;
	name: string;
	period?: number;
	qrFormat?: "svg" | "png";
	qrScale?: number;
	secret?: string;
	skew?: number;
	url?: string;
}

/** A created key; a generated key returns its otpauth URL (and QR) once. */
export interface VaultTotpCreated {
	key: VaultTotpKey;
	qr?: string;
	qrFormat?: "svg" | "png";
	url?: string;
}

export interface VaultTotpCode {
	code: string;
	period: number;
	remainingSecs: number;
}

export interface VaultPasswordPolicyRule {
	charset: string;
	minChars?: number;
}

export interface VaultPasswordPolicy {
	createdAt: VaultTimestamp;
	description: string;
	length: number;
	name: string;
	rules: VaultPasswordPolicyRule[];
	updatedAt: VaultTimestamp;
}

const vaultTotpKeyFields = z.object({
	name: vaultText,
	issuer: vaultText,
	account: vaultText,
	algorithm: z.enum(["SHA1", "SHA256", "SHA512"]),
	digits: vaultNumber,
	period: vaultNumber,
});
const vaultTotpKeysReply = vaultReply<{ keys: VaultTotpKey[] }>(
	z.object({ keys: z.array(vaultTotpKeyFields) })
);
const vaultTotpKeyReply = vaultReply<{ key: VaultTotpKey }>(
	z.object({ key: vaultTotpKeyFields })
);
const vaultTotpCreatedReply = vaultReply<VaultTotpCreated>(
	z.object({ key: vaultTotpKeyFields, url: vaultText.optional() })
);
const vaultTotpCodeReply = vaultReply<VaultTotpCode>(
	z.object({
		code: vaultText,
		period: vaultNumber,
		remainingSecs: vaultNumber,
	})
);
const vaultValidReply = vaultReply<{ valid: boolean }>(
	z.object({ valid: z.boolean() })
);
const vaultPasswordPolicyFields = z.object({
	name: vaultText,
	length: vaultNumber,
	rules: z.array(z.object({ charset: vaultText })),
});
const vaultPasswordPoliciesReply = vaultReply<{
	policies: VaultPasswordPolicy[];
}>(z.object({ policies: z.array(vaultPasswordPolicyFields) }));
const vaultPasswordPolicyReply = vaultReply<{ policy: VaultPasswordPolicy }>(
	z.object({ policy: vaultPasswordPolicyFields })
);
const vaultPasswordReply = vaultReply<{ password: string }>(
	z.object({ password: vaultText })
);

function totpPath(kind: "keys" | "code" | "validate", name?: string): string {
	return `/api/vault/totp/${kind}${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;
}

export function listVaultTotpKeys(
	target: ApiTarget
): Promise<{ keys: VaultTotpKey[] }> {
	return request(target, totpPath("keys"), {}, vaultTotpKeysReply);
}

export function createVaultTotpKey(
	target: ApiTarget,
	input: VaultTotpCreateInput
): Promise<VaultTotpCreated> {
	return request(
		target,
		totpPath("keys"),
		{ method: "POST", body: input },
		vaultTotpCreatedReply
	);
}

export function getVaultTotpKey(
	target: ApiTarget,
	name: string
): Promise<{ key: VaultTotpKey }> {
	return request(target, totpPath("keys", name), {}, vaultTotpKeyReply);
}

export function deleteVaultTotpKey(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		totpPath("keys", name),
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** The current code (`use` on `sys/totp/<name>`; audited). */
export function getVaultTotpCode(
	target: ApiTarget,
	name: string
): Promise<VaultTotpCode> {
	return request(target, totpPath("code", name), {}, vaultTotpCodeReply);
}

export function validateVaultTotpCode(
	target: ApiTarget,
	name: string,
	code: string
): Promise<{ valid: boolean }> {
	return request(
		target,
		totpPath("validate", name),
		{ method: "POST", body: { code } },
		vaultValidReply
	);
}

export function vaultAgentTotpCode(
	target: VaultAgentTarget,
	name: string
): Promise<VaultTotpCode> {
	return agentRequest(
		vaultTotpCodeReply,
		target,
		`/api/vault/agent/totp/code/${encodeURIComponent(name)}`
	);
}

export function vaultAgentTotpValidate(
	target: VaultAgentTarget,
	name: string,
	code: string
): Promise<{ valid: boolean }> {
	return agentRequest(
		vaultValidReply,
		target,
		`/api/vault/agent/totp/validate/${encodeURIComponent(name)}`,
		{ method: "POST", body: { code } }
	);
}

function passwordPolicyPath(name?: string, suffix = ""): string {
	return `/api/vault/sys/password-policies${name === undefined ? "" : `/${encodeURIComponent(name)}`}${suffix}`;
}

export function listVaultPasswordPolicies(
	target: ApiTarget
): Promise<{ policies: VaultPasswordPolicy[] }> {
	return request(target, passwordPolicyPath(), {}, vaultPasswordPoliciesReply);
}

export function getVaultPasswordPolicy(
	target: ApiTarget,
	name: string
): Promise<{ policy: VaultPasswordPolicy }> {
	return request(
		target,
		passwordPolicyPath(name),
		{},
		vaultPasswordPolicyReply
	);
}

/** `length` is 8–256; the rules' minimums must fit inside it. */
export function putVaultPasswordPolicy(
	target: ApiTarget,
	name: string,
	input: {
		description?: string;
		length: number;
		rules: VaultPasswordPolicyRule[];
	}
): Promise<{ policy: VaultPasswordPolicy }> {
	return request(
		target,
		passwordPolicyPath(name),
		{ method: "PUT", body: input },
		vaultPasswordPolicyReply
	);
}

export function deleteVaultPasswordPolicy(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		passwordPolicyPath(name),
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

export function generateVaultPassword(
	target: ApiTarget,
	policy: string
): Promise<{ password: string }> {
	return request(
		target,
		passwordPolicyPath(policy, "/generate"),
		{},
		vaultPasswordReply
	);
}

export function vaultAgentGeneratePassword(
	target: VaultAgentTarget,
	policy: string
): Promise<{ password: string }> {
	return agentRequest(
		vaultPasswordReply,
		target,
		`/api/vault/agent/password-policies/${encodeURIComponent(policy)}/generate`
	);
}

// ── Typed credential items ───────────────────────────────────────────────────

export type VaultItemFieldType =
	| "text"
	| "email"
	| "url"
	| "password"
	| "totp"
	| "note";

export type VaultItemStatus = "pending_collection" | "ready";

export interface VaultItemLocation {
	environment?: string;
	path?: string;
}

export interface VaultItemFieldInput {
	label?: string;
	name: string;
	required?: boolean;
	/** Defaults to true for `password` and `totp`, false otherwise. */
	sensitive?: boolean;
	type: VaultItemFieldType;
}

export interface VaultItemField {
	hasValue: boolean;
	label?: string;
	name: string;
	required: boolean;
	sensitive: boolean;
	type: VaultItemFieldType;
	/** Present for non-sensitive fields when the caller has `use` or `read`. */
	value?: string;
}

/** Non-sensitive metadata of a `card` item. Never the number or CVC. */
export interface VaultCardSummary {
	brand?: string;
	expired: boolean;
	expMonth?: string;
	expYear?: string;
	last4?: string;
	/** Merchant host patterns the card may be used at. */
	merchants: string[];
	/** Broker placeholders by field (`number` → `__CARD_<KEY>_NUMBER__`). */
	placeholders: Record<string, string>;
}

export interface VaultItemSummary {
	card?: VaultCardSummary;
	environment: string;
	fieldCount: number;
	id: string;
	key: string;
	kind: string;
	path: string;
	status: VaultItemStatus;
	updatedAt: VaultTimestamp;
	version: number;
}

export interface VaultItem {
	availableOperations: string[];
	card?: VaultCardSummary;
	createdAt: VaultTimestamp;
	description?: string;
	environment: string;
	fields: VaultItemField[];
	id: string;
	key: string;
	kind: string;
	path: string;
	status: VaultItemStatus;
	updatedAt: VaultTimestamp;
	version: number;
}

export interface PutVaultItemInput extends VaultItemLocation {
	description?: string;
	/** Required except for `card` items, whose schema is fixed. */
	fields?: VaultItemFieldInput[];
	kind?: string;
	/** Merchant host allowlist (`card` items only). */
	merchants?: string[];
	values?: Record<string, string>;
}

/** A guarded change: `null` clears a value or the description. */
export interface PatchVaultItemInput extends VaultItemLocation {
	description?: string | null;
	expectedId: string;
	expectedVersion: number;
	/** Replace a card's merchant host allowlist. */
	merchants?: string[];
	values?: Record<string, string | null>;
}

export interface VaultItemEvent {
	actorId?: string;
	actorKind: string;
	createdAt: VaultTimestamp;
	data: AppJsonValue;
	itemId: string;
	name: string;
	seq: number;
	version: number;
}

const vaultItemStatus = z.enum(["pending_collection", "ready"]);
const vaultItemFields = z.object({
	id: vaultText,
	environment: vaultText,
	path: vaultText,
	key: vaultText,
	kind: vaultText,
	version: vaultNumber,
	status: vaultItemStatus,
	fields: z.array(
		z.object({
			name: vaultText,
			type: vaultText,
			sensitive: z.boolean(),
			hasValue: z.boolean(),
		})
	),
});
const vaultItemsReply = vaultReply<{ items: VaultItemSummary[] }>(
	z.object({
		items: z.array(
			z.object({
				id: vaultText,
				key: vaultText,
				kind: vaultText,
				version: vaultNumber,
				status: vaultItemStatus,
			})
		),
	})
);
const vaultItemReply = vaultReply<{ item: VaultItem }>(
	z.object({ item: vaultItemFields })
);
const vaultItemRevealReply = vaultReply<{ field: string; value: string }>(
	z.object({ field: vaultText, value: vaultText })
);
const vaultItemEventsReply = vaultReply<{
	events: VaultItemEvent[];
	next: number;
}>(
	z.object({
		events: z.array(z.object({ seq: vaultNumber, name: vaultText })),
		next: vaultNumber,
	})
);

function itemPath(key: string, suffix = ""): string {
	return `/api/vault/items/${encodeURIComponent(key)}${suffix}`;
}

export function listVaultItems(
	target: ApiTarget,
	location: VaultItemLocation = {}
): Promise<{ items: VaultItemSummary[] }> {
	return request(
		target,
		`/api/vault/items${locationQuery(location)}`,
		{},
		vaultItemsReply
	);
}

/** The field schema, `hasValue`, and non-sensitive values. */
export function getVaultItem(
	target: ApiTarget,
	key: string,
	location: VaultItemLocation = {}
): Promise<{ item: VaultItem }> {
	return request(
		target,
		`${itemPath(key)}${locationQuery(location)}`,
		{},
		vaultItemReply
	);
}

/** Create an item, or confirm an identical one (Core answers 201 or 200;
 *  a different schema or value is a 409). */
export function putVaultItem(
	target: ApiTarget,
	key: string,
	input: PutVaultItemInput
): Promise<{ item: VaultItem }> {
	return request(
		target,
		itemPath(key),
		{ method: "PUT", body: input },
		vaultItemReply
	);
}

export function patchVaultItem(
	target: ApiTarget,
	key: string,
	input: PatchVaultItemInput
): Promise<{ item: VaultItem }> {
	return request(
		target,
		itemPath(key),
		{ method: "PATCH", body: input },
		vaultItemReply
	);
}

export function deleteVaultItem(
	target: ApiTarget,
	key: string,
	options: VaultItemLocation & { expectedVersion?: number } = {}
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`${itemPath(key)}${query({
			environment: options.environment,
			path: options.path,
			expectedVersion: options.expectedVersion,
		})}`,
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** Reveal one field's value (`read`; audited). */
export function revealVaultItemField(
	target: ApiTarget,
	key: string,
	field: string,
	location: VaultItemLocation = {}
): Promise<{ field: string; value: string }> {
	return request(
		target,
		itemPath(key, "/reveal"),
		{ method: "POST", body: { ...location, field } },
		vaultItemRevealReply
	);
}

/** The item's event timeline after `after`, long-polling up to `wait` seconds. */
export function listVaultItemEvents(
	target: ApiTarget,
	key: string,
	options: VaultItemLocation & {
		after?: number;
		limit?: number;
		wait?: number;
	} = {},
	signal?: AbortSignal
): Promise<{ events: VaultItemEvent[]; next: number }> {
	return request(
		target,
		`${itemPath(key, "/events")}${query({
			environment: options.environment,
			path: options.path,
			after: options.after,
			limit: options.limit,
			wait: options.wait,
		})}`,
		{ signal },
		vaultItemEventsReply
	);
}

// ── Payment cards ────────────────────────────────────────────────────────────

/** A new payment card. The number and CVC are sent once and never returned. */
export interface PutVaultCardInput extends VaultItemLocation {
	addressLine1?: string;
	addressLine2?: string;
	cardholder: string;
	city?: string;
	/** Two-letter ISO 3166 code. */
	country?: string;
	cvc?: string;
	description?: string;
	/** 1-12. */
	expMonth: string | number;
	/** YY or YYYY. */
	expYear: string | number;
	/** Merchant host patterns (`shop.example.com` or `*.example.com`). */
	merchants: string[];
	/** 12-19 digits; spaces and dashes are ignored; Luhn-checked by Core. */
	number: string;
	postalCode?: string;
	region?: string;
}

const CARD_OPTIONAL_FIELDS = [
	"cvc",
	"postalCode",
	"country",
	"addressLine1",
	"addressLine2",
	"city",
	"region",
] as const;

/** The `PUT /api/vault/items/{key}` body for a card. */
export function vaultCardItemInput(
	input: PutVaultCardInput
): PutVaultItemInput {
	const values: Record<string, string> = {
		cardholder: input.cardholder,
		number: input.number,
		expMonth: String(input.expMonth),
		expYear: String(input.expYear),
	};
	for (const name of CARD_OPTIONAL_FIELDS) {
		const value = input[name];
		if (value !== undefined && value !== "") {
			values[name] = value;
		}
	}
	const body: PutVaultItemInput = {
		kind: "card",
		merchants: input.merchants,
		values,
	};
	if (input.environment !== undefined) {
		body.environment = input.environment;
	}
	if (input.path !== undefined) {
		body.path = input.path;
	}
	if (input.description !== undefined) {
		body.description = input.description;
	}
	return body;
}

/** Create a payment card item (or confirm an identical one). */
export function putVaultCard(
	target: ApiTarget,
	key: string,
	input: PutVaultCardInput
): Promise<{ item: VaultItem }> {
	return putVaultItem(target, key, vaultCardItemInput(input));
}

export type VaultCardChannel = "broker" | "fill" | "reveal";

export type VaultCardApprovalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "expired"
	| "consumed"
	| "revoked";

/** A card spend approval request or grant. Never carries a card value. */
export interface VaultCardApproval {
	/** `machine:<id>`, `user:<id>`, or `operator`. */
	agent: string;
	brand?: string;
	channel: VaultCardChannel;
	decidedAt?: VaultTimestamp;
	decidedBy?: string;
	environment: string;
	/** The field a reveal asks for (`number` or `cvc`); absent otherwise. */
	field?: string;
	grantExpiresAt?: VaultTimestamp;
	grantSubject?: string;
	id: string;
	itemId: string;
	key: string;
	last4?: string;
	maxUses?: number;
	/** Empty for a reveal. */
	merchantHost: string;
	mode?: "once" | "grant";
	note?: string;
	path: string;
	requestExpiresAt: VaultTimestamp;
	requestedAt: VaultTimestamp;
	/** `broker_session:<id>`, `user:<id>`, or `operator`. */
	requester: string;
	status: VaultCardApprovalStatus;
	uses: number;
}

/** A human's approval: one use, or a grant for the requesting session (or
 *  its agent) at that merchant, for `ttlSecs` (60-86400, default 900; a
 *  `once` approval must also be used within it). */
export interface VaultCardApproveInput {
	maxUses?: number;
	mode?: "once" | "grant";
	note?: string;
	subject?: "session" | "agent";
	ttlSecs?: number;
}

/** A card use either releases values or answers `202` with the pending
 *  approval request a human must decide first. */
export type VaultCardUseResult<T> =
	| ({ status: "released" } & T)
	| {
			approval: VaultCardApproval;
			approvePath: string;
			status: "approval_required";
	  };

const vaultCardApprovalFields = z.object({
	id: vaultText,
	key: vaultText,
	channel: z.enum(["broker", "fill", "reveal"]),
	merchantHost: z.string(),
	status: z.enum([
		"pending",
		"approved",
		"rejected",
		"expired",
		"consumed",
		"revoked",
	]),
	uses: vaultNumber,
});
const vaultCardApprovalReply = vaultReply<{ approval: VaultCardApproval }>(
	z.object({ approval: vaultCardApprovalFields })
);
const vaultCardApprovalsReply = vaultReply<{
	approvals: VaultCardApproval[];
}>(z.object({ approvals: z.array(vaultCardApprovalFields) }));
const vaultCardPendingFields = z.object({
	status: z.literal("approval_required"),
	approval: vaultCardApprovalFields,
	approvePath: vaultText,
});
type VaultCardPending = Extract<
	VaultCardUseResult<unknown>,
	{ status: "approval_required" }
>;
const vaultCardFillReply = vaultReply<
	| VaultCardPending
	| {
			approvalId: string;
			card: { brand?: string; last4?: string };
			fields: Record<string, string>;
			origin: string;
	  }
>(
	z.union([
		vaultCardPendingFields,
		z.object({
			origin: vaultText,
			fields: z.record(z.string(), z.string()),
			approvalId: vaultText,
		}),
	])
);
const vaultCardRevealReply = vaultReply<
	VaultCardPending | { field: string; value: string }
>(
	z.union([
		vaultCardPendingFields,
		z.object({ field: vaultText, value: vaultText }),
	])
);

function isPending(value: unknown): value is VaultCardPending {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		value.status === "approval_required"
	);
}

/** Fill a card into an allowlisted HTTPS origin (`use` and `read`: the reply
 *  carries the number and security code). Each fill needs a spend approval;
 *  without a live grant Core answers with a pending request. */
export async function fillVaultCard(
	target: ApiTarget,
	key: string,
	origin: string,
	location: VaultItemLocation = {}
): Promise<
	VaultCardUseResult<{
		approvalId: string;
		card: { brand?: string; last4?: string };
		fields: Record<string, string>;
		origin: string;
	}>
> {
	const reply = await request(
		target,
		itemPath(key, "/fill"),
		{ method: "POST", body: { ...location, origin } },
		vaultCardFillReply
	);
	return isPending(reply) ? reply : { status: "released", ...reply };
}

/** Reveal a card's number or CVC (`read`). Every reveal needs a single-use
 *  approval; the first call returns the pending request. */
export async function revealVaultCardField(
	target: ApiTarget,
	key: string,
	field: string,
	location: VaultItemLocation = {}
): Promise<VaultCardUseResult<{ field: string; value: string }>> {
	const reply = await request(
		target,
		itemPath(key, "/reveal"),
		{ method: "POST", body: { ...location, field } },
		vaultCardRevealReply
	);
	return isPending(reply) ? reply : { status: "released", ...reply };
}

function cardApprovalPath(id?: string, suffix = ""): string {
	return id === undefined
		? "/api/vault/cards/approvals"
		: `/api/vault/cards/approvals/${encodeURIComponent(id)}${suffix}`;
}

/** Card spend approvals the caller may see (`list` on the card). */
export function listVaultCardApprovals(
	target: ApiTarget,
	filter: { environment?: string; status?: VaultCardApprovalStatus } = {}
): Promise<{ approvals: VaultCardApproval[] }> {
	return request(
		target,
		`${cardApprovalPath()}${query({
			status: filter.status,
			environment: filter.environment,
		})}`,
		{},
		vaultCardApprovalsReply
	);
}

export function getVaultCardApproval(
	target: ApiTarget,
	id: string
): Promise<{ approval: VaultCardApproval }> {
	return request(target, cardApprovalPath(id), {}, vaultCardApprovalReply);
}

/** Approve (once or as a grant), reject a pending request, or revoke a
 *  grant. Needs `write` on the card. */
export function decideVaultCardApproval(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject" | "revoke",
	input: VaultCardApproveInput = {}
): Promise<{ approval: VaultCardApproval }> {
	const body: VaultCardApproveInput =
		decision === "approve" ? { ...input } : {};
	if (decision !== "approve" && input.note) {
		body.note = input.note;
	}
	return request(
		target,
		cardApprovalPath(id, `/${decision}`),
		{ method: "POST", body },
		vaultCardApprovalReply
	);
}

/** Poll an approval the agent's broker session (or machine) requested. */
export function vaultAgentCardApproval(
	target: VaultAgentTarget,
	id: string
): Promise<{ approval: Partial<VaultCardApproval> & { id: string } }> {
	return agentRequest(
		vaultReply<{ approval: Partial<VaultCardApproval> & { id: string } }>(
			z.object({ approval: z.object({ id: vaultText, status: vaultText }) })
		),
		target,
		`/api/vault/agent/cards/approvals/${encodeURIComponent(id)}`
	);
}

// ── Token lifecycle, response wrapping, cubbyhole ────────────────────────────

/** Header asking Core to wrap a response (`300`, `300s`, `5m`, or `1h`). */
export const VAULT_WRAP_TTL_HEADER = "x-ryu-wrap-ttl";

export interface VaultTokenInfo {
	accessor: string;
	boundCidrs: string[];
	createdAt: VaultTimestamp;
	expiresAt: VaultTimestamp;
	identityId: string;
	lastUsedAt: VaultTimestamp | null;
	maxExpiresAt: VaultTimestamp | null;
	numUsesRemaining: number | null;
	orphan: boolean;
	parentAccessor: string | null;
	periodSecs: number | null;
	policies: string[];
	renewable: boolean;
	revokedAt: VaultTimestamp | null;
	role: string | null;
	ttlSecs: number;
}

export interface VaultTokenRequest {
	boundCidrs?: string[];
	explicitMaxTtlSecs?: number;
	numUses?: number;
	orphan?: boolean;
	periodSecs?: number;
	policies?: string[];
	renewable?: boolean;
	role?: string;
	ttlSecs?: number;
}

export interface VaultTokenRole {
	allowedPolicies: string[];
	boundCidrs?: string[];
	createdAt: VaultTimestamp;
	disallowedPolicies: string[];
	explicitMaxTtlSecs?: number;
	maxTtlSecs?: number;
	name: string;
	numUses?: number;
	orphan: boolean;
	periodSecs?: number;
	renewable?: boolean;
	ttlSecs?: number;
	updatedAt: VaultTimestamp;
}

export type VaultTokenRoleInput = Partial<
	Omit<VaultTokenRole, "name" | "createdAt" | "updatedAt">
>;

export interface VaultRevokeReport {
	leasesFailed: number;
	leasesRevoked: number;
	tokens: number;
}

export interface VaultWrapInfo {
	accessor: string;
	createdAt: VaultTimestamp;
	creationPath: string;
	expiresAt: VaultTimestamp;
	/** The single-use wrapping token; absent from lookups. */
	token?: string;
	ttlSecs: number;
}

export interface VaultCubbyholeEntry {
	createdAt: VaultTimestamp;
	key: string;
	updatedAt: VaultTimestamp;
}

const vaultTokenInfoFields = z.object({
	accessor: vaultText,
	identityId: vaultText,
	policies: z.array(vaultText),
	expiresAt: vaultDate,
	renewable: z.boolean(),
	ttlSecs: vaultNumber,
});
const vaultTokensReply = vaultReply<{ tokens: VaultTokenInfo[] }>(
	z.object({ tokens: z.array(vaultTokenInfoFields) })
);
const vaultTokenInfoReply = vaultReply<{ token: VaultTokenInfo }>(
	z.object({ token: vaultTokenInfoFields })
);
const vaultTokenSelfReply = vaultReply<{
	effectivePolicies: string[];
	token: VaultTokenInfo;
}>(
	z.object({
		token: vaultTokenInfoFields,
		effectivePolicies: z.array(vaultText),
	})
);
const vaultRevokeReportReply = vaultReply<{ revoked: VaultRevokeReport }>(
	z.object({
		revoked: z.object({
			tokens: vaultNumber,
			leasesRevoked: vaultNumber,
			leasesFailed: vaultNumber,
		}),
	})
);
const vaultTokenRoleFields = z.object({
	name: vaultText,
	allowedPolicies: z.array(vaultText),
	disallowedPolicies: z.array(vaultText),
	orphan: z.boolean(),
});
const vaultTokenRolesReply = vaultReply<{ roles: VaultTokenRole[] }>(
	z.object({ roles: z.array(vaultTokenRoleFields) })
);
const vaultTokenRoleReply = vaultReply<{ role: VaultTokenRole }>(
	z.object({ role: vaultTokenRoleFields })
);
const vaultWrapInfoReply = vaultReply<{ wrapInfo: VaultWrapInfo }>(
	z.object({
		wrapInfo: z.object({
			accessor: vaultText,
			ttlSecs: vaultNumber,
			creationPath: vaultText,
			expiresAt: vaultDate,
		}),
	})
);
const vaultUnwrappedReply = vaultReply<Record<string, AppJsonValue>>(
	z.record(z.string(), appJsonValueSchema)
);
const vaultCubbyholeKeysReply = vaultReply<{ keys: VaultCubbyholeEntry[] }>(
	z.object({ keys: z.array(z.object({ key: vaultText })) })
);
const vaultCubbyholeValueReply = vaultReply<{ value: AppJsonValue }>(
	z.object({ value: appJsonValueSchema })
);
const vaultWrittenReply = vaultReply<{ written: boolean }>(
	z.object({ written: z.boolean() })
);

function tokenPath(accessor: string, suffix = ""): string {
	return `/api/vault/tokens/${encodeURIComponent(accessor)}${suffix}`;
}

function wrapTtlHeaders(ttl: string | number | undefined): {
	[name: string]: string;
} {
	return ttl === undefined ? {} : { [VAULT_WRAP_TTL_HEADER]: String(ttl) };
}

export function listVaultTokens(
	target: ApiTarget,
	filter: { identity?: string } = {}
): Promise<{ tokens: VaultTokenInfo[] }> {
	return request(
		target,
		`/api/vault/tokens${query({ identity: filter.identity })}`,
		{},
		vaultTokensReply
	);
}

/** Mint a token for a machine identity; the `rvt_…` token is shown once. */
export function createVaultToken(
	target: ApiTarget,
	input: VaultTokenRequest & { identity: string }
): Promise<{ token: VaultIssuedToken }> {
	return request(
		target,
		"/api/vault/tokens",
		{ method: "POST", body: input },
		vaultMachineLoginResponse
	);
}

export function lookupVaultToken(
	target: ApiTarget,
	accessor: string
): Promise<{ token: VaultTokenInfo }> {
	return request(target, tokenPath(accessor), {}, vaultTokenInfoReply);
}

export function renewVaultToken(
	target: ApiTarget,
	accessor: string,
	options: { incrementSecs?: number } = {}
): Promise<{ token: VaultTokenInfo }> {
	return request(
		target,
		tokenPath(accessor, "/renew"),
		{ method: "POST", body: options },
		vaultTokenInfoReply
	);
}

/** Revoke a token but keep its children as orphans (admin on `sys/machines`). */
export function revokeVaultTokenOrphan(
	target: ApiTarget,
	accessor: string
): Promise<{ revoked: VaultRevokeReport }> {
	return request(
		target,
		tokenPath(accessor, "/revoke-orphan"),
		{ method: "POST" },
		vaultRevokeReportReply
	);
}

export function listVaultTokenRoles(
	target: ApiTarget
): Promise<{ roles: VaultTokenRole[] }> {
	return request(target, "/api/vault/token-roles", {}, vaultTokenRolesReply);
}

export function getVaultTokenRole(
	target: ApiTarget,
	name: string
): Promise<{ role: VaultTokenRole }> {
	return request(
		target,
		`/api/vault/token-roles/${encodeURIComponent(name)}`,
		{},
		vaultTokenRoleReply
	);
}

export function putVaultTokenRole(
	target: ApiTarget,
	name: string,
	input: VaultTokenRoleInput
): Promise<{ role: VaultTokenRole }> {
	return request(
		target,
		`/api/vault/token-roles/${encodeURIComponent(name)}`,
		{ method: "PUT", body: input },
		vaultTokenRoleReply
	);
}

export function deleteVaultTokenRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/token-roles/${encodeURIComponent(name)}`,
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** Wrap a JSON object behind a single-use wrapping token (`use` on
 *  `sys/wrapping`). `ttl` defaults to Core's wrap TTL. */
export function vaultWrap(
	target: ApiTarget,
	data: Record<string, AppJsonValue>,
	options: { ttl?: string | number } = {}
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return request(
		target,
		"/api/vault/sys/wrapping/wrap",
		{ method: "POST", body: data, headers: wrapTtlHeaders(options.ttl) },
		vaultWrapInfoReply
	);
}

/** Unwrap once and return the original response. Public: no bearer is sent. */
export function vaultUnwrap(
	target: VaultMachineTarget,
	wrapToken: string
): Promise<Record<string, AppJsonValue>> {
	return machineRequest(
		vaultUnwrappedReply,
		target,
		"/api/vault/sys/wrapping/unwrap",
		{ method: "POST", body: { token: wrapToken } }
	);
}

/** Describe a wrapping token without consuming it. */
export function vaultWrapLookup(
	target: VaultMachineTarget,
	wrapToken: string
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return machineRequest(
		vaultWrapInfoReply,
		target,
		"/api/vault/sys/wrapping/lookup",
		{ method: "POST", body: { token: wrapToken } }
	);
}

/** Move a wrapped response to a new token (consumes the old one). */
export function vaultRewrap(
	target: VaultMachineTarget,
	wrapToken: string
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return machineRequest(
		vaultWrapInfoReply,
		target,
		"/api/vault/sys/wrapping/rewrap",
		{ method: "POST", body: { token: wrapToken } }
	);
}

export function vaultAgentLookupSelf(
	target: VaultAgentTarget
): Promise<{ effectivePolicies: string[]; token: VaultTokenInfo }> {
	return agentRequest(
		vaultTokenSelfReply,
		target,
		"/api/vault/agent/self/lookup"
	);
}

export function vaultAgentRenewSelf(
	target: VaultAgentTarget,
	options: { incrementSecs?: number } = {}
): Promise<{ token: VaultTokenInfo }> {
	return agentRequest(
		vaultTokenInfoReply,
		target,
		"/api/vault/agent/self/renew",
		{ method: "POST", body: options }
	);
}

/** Mint a narrower child token (policy subset; TTL capped by the parent). */
export function vaultAgentCreateChild(
	target: VaultAgentTarget,
	input: VaultTokenRequest = {}
): Promise<{ token: VaultIssuedToken }> {
	return agentRequest(
		vaultMachineLoginResponse,
		target,
		"/api/vault/agent/self/child",
		{ method: "POST", body: input }
	);
}

export function vaultAgentWrap(
	target: VaultAgentTarget,
	data: Record<string, AppJsonValue>,
	options: { ttl?: string | number } = {}
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return agentRequest(
		vaultWrapInfoReply,
		target,
		"/api/vault/agent/wrapping/wrap",
		{ method: "POST", body: data, headers: wrapTtlHeaders(options.ttl) }
	);
}

/** Reveal a value wrapped behind a single-use token: Core wraps the reveal
 *  response itself, so the plaintext never reaches this client. */
export function wrapVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords & { version?: number },
	ttl: string | number
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return request(
		target,
		secretPath(name, "/reveal"),
		{ method: "POST", body: coords, headers: wrapTtlHeaders(ttl) },
		vaultWrapInfoReply
	);
}

/** {@link wrapVaultSecret} with a machine token (node-scoped values). */
export function vaultAgentWrapSecret(
	target: VaultAgentTarget,
	name: string,
	location: { environment?: string; path?: string },
	ttl: string | number
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return agentRequest(
		vaultWrapInfoReply,
		target,
		`/api/vault/agent/secrets/${encodeURIComponent(name)}${query(location)}`,
		{ headers: wrapTtlHeaders(ttl) }
	);
}

function cubbyholePath(key?: string): string {
	return `/api/vault/agent/cubbyhole${key === undefined ? "" : `/${encodeURIComponent(key)}`}`;
}

export function vaultAgentCubbyholeList(
	target: VaultAgentTarget
): Promise<{ keys: VaultCubbyholeEntry[] }> {
	return agentRequest(vaultCubbyholeKeysReply, target, cubbyholePath());
}

export function vaultAgentCubbyholeGet(
	target: VaultAgentTarget,
	key: string
): Promise<{ value: AppJsonValue }> {
	return agentRequest(vaultCubbyholeValueReply, target, cubbyholePath(key));
}

export function vaultAgentCubbyholePut(
	target: VaultAgentTarget,
	key: string,
	value: AppJsonValue
): Promise<{ written: boolean }> {
	return agentRequest(vaultWrittenReply, target, cubbyholePath(key), {
		method: "PUT",
		body: value,
	});
}

export function vaultAgentCubbyholeDelete(
	target: VaultAgentTarget,
	key: string
): Promise<{ deleted: boolean }> {
	return agentRequest(vaultDeletedReply, target, cubbyholePath(key), {
		method: "DELETE",
	});
}

// ── Reference grammar ────────────────────────────────────────────────────────

// Full human response owners: vault_api.rs renderers plus their native serde models.
// Validate every declared publisher field and retain the complete decoded object.
const vaultHumanText = z.string();
const vaultHumanNumber = vaultMachineNumber;
const vaultHumanTimestamp = vaultMachineDate;
const vaultHumanScope = z.enum(["user", "node", "team", "org"]);
const vaultHumanCapabilities = z.array(
	z.enum(["list", "use", "read", "write", "delete", "admin", "approve"])
);
const vaultHumanBinding = vaultMachineCodec(
	z.object({ kind: z.literal("mcp"), id: vaultHumanText })
);
const vaultHumanCoords = vaultMachineCodec(
	z.object({
		scope: vaultHumanScope,
		scopeId: vaultHumanText,
		environment: vaultHumanText,
		path: vaultHumanText,
		name: vaultHumanText,
		binding: vaultHumanBinding.optional(),
	})
);
const vaultHumanGenerator = vaultMachineCodec(
	z.object({
		kind: z.literal("random"),
		charset: z.enum(["alphanumeric", "hex", "base64url", "symbols"]),
		length: vaultHumanNumber,
	})
);
const vaultHumanMetadata = vaultMachineCodec(
	z.object({
		description: vaultHumanText,
		tags: z.array(vaultHumanText),
		expiresAt: vaultHumanTimestamp.nullable(),
		rotationPeriodSecs: vaultHumanNumber.nullable(),
		generator: vaultHumanGenerator.nullable(),
		expandReferences: z.boolean(),
		maxVersions: vaultHumanNumber,
	})
);
const vaultHumanSecret = vaultMachineCodec(
	z.object({
		scope: vaultHumanScope,
		scopeId: vaultHumanText,
		environment: vaultHumanText,
		path: vaultHumanText,
		name: vaultHumanText,
		binding: vaultHumanBinding.optional(),
		version: vaultHumanNumber,
		status: z.enum(["active", "expired", "rotation_due", "deleted"]),
		metadata: vaultHumanMetadata,
		capabilities: vaultHumanCapabilities,
		createdAt: vaultHumanTimestamp.nullable(),
		createdBy: vaultHumanText.nullable(),
		updatedAt: vaultHumanTimestamp.nullable(),
		updatedBy: vaultHumanText.nullable(),
		rotatedAt: vaultHumanTimestamp.nullable(),
		deletedAt: vaultHumanTimestamp.nullable().optional(),
		source: vaultHumanText.optional(),
	})
);
const vaultHumanSeal = vaultMachineCodec(
	z.object({
		mode: z.enum(["auto", "shamir"]),
		sealed: z.boolean(),
		shares: vaultHumanNumber,
		threshold: vaultHumanNumber,
		progress: vaultHumanNumber,
		keyVersions: z.array(vaultHumanNumber),
		activeKeyVersion: vaultHumanNumber,
	})
);
const vaultHumanNode = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		scope: z.enum(["local", "org", "team", "personal"]),
		orgId: vaultHumanText.nullable(),
		teamId: vaultHumanText.nullable(),
		ownerUserId: vaultHumanText.nullable(),
	})
);
const vaultHumanCaller = vaultMachineCodec(
	z.object({
		userId: vaultHumanText,
		orgId: vaultHumanText.nullable(),
		role: z.enum(["owner", "admin", "member", "viewer"]),
		teamIds: z.array(vaultHumanText),
	})
);
const vaultHumanList = vaultMachineCodec(
	z.object({
		secrets: z.array(vaultHumanSecret),
		node: vaultHumanNode,
		caller: vaultHumanCaller.nullable(),
		canManageShared: z.boolean(),
		sharedRemote: z.boolean(),
		sharedError: vaultHumanText.nullable(),
		activeEnvironment: vaultHumanText,
		seal: vaultHumanSeal,
	})
);
const vaultHumanApproval = vaultMachineCodec(
	z.object({ by: vaultHumanText, at: vaultHumanTimestamp.nullable() })
);
const vaultHumanChange = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		status: z.enum(["pending", "applied", "rejected", "canceled"]),
		operation: z.enum(["write", "delete"]),
		coords: vaultHumanCoords,
		hasValue: z.boolean(),
		patch: appJsonValueSchema,
		requestedBy: vaultHumanText,
		requestedAt: vaultHumanTimestamp.nullable(),
		approvals: z.array(vaultHumanApproval),
		requiredApprovals: vaultHumanNumber,
		decidedBy: vaultHumanText.nullable(),
		decidedAt: vaultHumanTimestamp.nullable(),
		reason: vaultHumanText.nullable(),
	})
);
const vaultHumanWrite = vaultMachineCodec(
	z.union([
		z.object({ ok: z.boolean(), secret: vaultHumanSecret }),
		z.object({ ok: z.boolean(), changeRequest: vaultHumanChange }),
	])
);
const vaultHumanDelete = vaultMachineCodec(
	z.union([
		z.object({
			ok: z.boolean(),
			deleted: z.boolean(),
			scope: vaultHumanScope,
			scopeId: vaultHumanText,
			name: vaultHumanText,
			environment: vaultHumanText,
			path: vaultHumanText,
			binding: vaultHumanBinding.nullable().optional(),
		}),
		z.object({ ok: z.boolean(), changeRequest: vaultHumanChange }),
	])
);
const vaultHumanVersion = vaultMachineCodec(
	z.object({
		version: vaultHumanNumber,
		createdAt: vaultHumanTimestamp.nullable(),
		createdBy: vaultHumanText.nullable(),
		source: vaultHumanText,
		destroyed: z.boolean(),
		current: z.boolean(),
	})
);
const vaultHumanVersions = vaultMachineCodec(
	z.object({ versions: z.array(vaultHumanVersion) })
);
const vaultHumanDestroyed = vaultMachineCodec(
	z.object({ ok: z.boolean(), destroyed: vaultHumanNumber })
);
const vaultHumanImportReport = vaultMachineCodec(
	z.object({
		created: vaultHumanNumber,
		updated: vaultHumanNumber,
		skipped: vaultHumanNumber,
		unchanged: vaultHumanNumber,
	})
);
const vaultHumanImported = vaultMachineCodec(
	z.object({ ok: z.boolean(), report: vaultHumanImportReport })
);
const vaultHumanSnapshot = vaultMachineCodec(
	z.object({
		format: vaultHumanText,
		version: vaultHumanNumber,
		createdAt: vaultHumanText,
		kdf: vaultMachineCodec(
			z.object({
				alg: vaultHumanText,
				iterations: vaultHumanNumber,
				salt: vaultHumanText,
			})
		),
		nonce: vaultHumanText,
		ciphertext: vaultHumanText,
	})
);
const vaultHumanFinding = vaultMachineCodec(
	z.object({
		rule: vaultHumanText,
		description: vaultHumanText,
		source: vaultHumanText.optional(),
		line: vaultHumanNumber,
		column: vaultHumanNumber,
		preview: vaultHumanText,
		fingerprint: vaultHumanText,
		secret: vaultHumanText.optional(),
	})
);
const vaultHumanFindings = vaultMachineCodec(
	z.object({ findings: z.array(vaultHumanFinding) })
);
const vaultHumanEnvironment = vaultMachineCodec(
	z.object({
		slug: vaultHumanText,
		name: vaultHumanText,
		protected: z.boolean(),
		requiredApprovals: vaultHumanNumber,
		position: vaultHumanNumber,
	})
);
const vaultHumanEnvironments = vaultMachineCodec(
	z.object({
		environments: z.array(vaultHumanEnvironment),
		active: vaultHumanText,
	})
);
const vaultHumanPutEnvironment = vaultMachineCodec(
	z.object({ ok: z.boolean(), environment: vaultHumanEnvironment })
);
const vaultHumanDeleted = vaultMachineCodec(
	z.object({ ok: z.boolean(), deleted: z.boolean() })
);
const vaultHumanFolders = vaultMachineCodec(
	z.object({ folders: z.array(vaultHumanText) })
);
const vaultHumanCreatedFolder = vaultMachineCodec(
	z.object({ ok: z.boolean(), path: vaultHumanText })
);
const vaultHumanFolderImport = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		environment: vaultHumanText,
		path: vaultHumanText,
		sourceEnvironment: vaultHumanText,
		sourcePath: vaultHumanText,
		position: vaultHumanNumber,
	})
);
const vaultHumanImports = vaultMachineCodec(
	z.object({ imports: z.array(vaultHumanFolderImport) })
);
const vaultHumanAddedImport = vaultMachineCodec(
	z.object({ ok: z.boolean(), import: vaultHumanFolderImport })
);
const vaultHumanRemoved = vaultMachineCodec(
	z.object({ ok: z.boolean(), removed: z.boolean() })
);
const vaultHumanPolicyRule = vaultMachineCodec(
	z.object({
		path: vaultHumanText,
		capabilities: vaultHumanCapabilities,
		deny: z.boolean(),
	})
);
const vaultHumanPolicy = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		description: vaultHumanText,
		rules: z.array(vaultHumanPolicyRule),
	})
);
const vaultHumanPolicyBinding = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		policy: vaultHumanText,
		subject: vaultHumanText,
		expiresAt: vaultHumanTimestamp.optional(),
	})
);
const vaultHumanPolicies = vaultMachineCodec(
	z.object({
		policies: z.array(vaultHumanPolicy),
		bindings: z.array(vaultHumanPolicyBinding),
	})
);
const vaultHumanPutPolicy = vaultMachineCodec(
	z.object({ ok: z.boolean(), policy: vaultHumanPolicy })
);
const vaultHumanBoundPolicy = vaultMachineCodec(
	z.object({ ok: z.boolean(), binding: vaultHumanPolicyBinding })
);
const vaultHumanChanges = vaultMachineCodec(
	z.object({
		changeRequests: z.array(vaultHumanChange),
		sharedError: vaultHumanText.nullable(),
	})
);
const vaultHumanDecidedChange = vaultMachineCodec(
	z.object({ ok: z.boolean(), changeRequest: vaultHumanChange })
);
const vaultHumanAuditActor = vaultMachineCodec(
	z.object({ kind: vaultHumanText, id: vaultHumanText.nullable() })
);
const vaultHumanAuditEvent = vaultMachineCodec(
	z.object({
		seq: vaultHumanNumber,
		at: vaultHumanText,
		actor: vaultHumanAuditActor,
		action: vaultHumanText,
		outcome: vaultHumanText,
		scope: vaultHumanText.optional(),
		scopeId: vaultHumanText.optional(),
		environment: vaultHumanText.optional(),
		path: vaultHumanText.optional(),
		name: vaultHumanText.optional(),
		details: appJsonValueSchema,
		requestId: vaultHumanText.optional(),
	})
);
const vaultHumanAudit = vaultMachineCodec(
	z.object({
		events: z.array(vaultHumanAuditEvent),
		nextBefore: vaultHumanNumber.nullable(),
	})
);
const vaultHumanAuditReport = vaultMachineCodec(
	z.object({
		ok: z.boolean(),
		rows: vaultHumanNumber,
		firstBadSeq: vaultHumanNumber.optional(),
	})
);
const vaultHumanAuditVerified = vaultMachineCodec(
	z.object({ report: vaultHumanAuditReport })
);
const vaultHumanStatus = vaultMachineCodec(
	z.object({
		seal: vaultHumanSeal,
		activeEnvironment: vaultHumanText,
		sharedRemote: z.boolean(),
	})
);
const vaultHumanSealResponse = vaultMachineCodec(
	z.object({ seal: vaultHumanSeal })
);
const vaultHumanShamirResponse = vaultMachineCodec(
	z.object({ shares: z.array(vaultHumanText), seal: vaultHumanSeal })
);
const vaultHumanRotateResponse = vaultMachineCodec(
	z.object({
		keyVersion: vaultHumanNumber,
		rewrapped: vaultHumanNumber,
		seal: vaultHumanSeal,
	})
);
const vaultHumanMigrationFailure = vaultMachineCodec(
	z.object({
		key: vaultHumanText,
		error: vaultHumanText,
		conflict: z.boolean().optional(),
	})
);
const vaultHumanMigration = vaultMachineCodec(
	z.object({
		ok: z.boolean(),
		moved: vaultHumanNumber,
		failed: z.array(vaultHumanMigrationFailure),
	})
);
const vaultHumanTransitKey = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		// Accept unknown types so a newer server's key types never break listing.
		type: vaultHumanText,
		latestVersion: vaultHumanNumber,
		minDecryptionVersion: vaultHumanNumber,
		minEncryptionVersion: vaultHumanNumber.optional(),
		minAvailableVersion: vaultHumanNumber.optional(),
		deletionAllowed: z.boolean(),
		derived: z.boolean().optional(),
		convergent: z.boolean().optional(),
		exportable: z.boolean().optional(),
		allowPlaintextBackup: z.boolean().optional(),
		autoRotatePeriodSecs: vaultHumanNumber.optional(),
		imported: z.boolean().optional(),
		createdAt: vaultHumanTimestamp,
		deletedAt: vaultHumanTimestamp.optional(),
		publicKeys: z.array(z.tuple([vaultHumanNumber, vaultHumanText])),
	})
);
const vaultHumanTransitKeys = vaultMachineCodec(
	z.object({ keys: z.array(vaultHumanTransitKey) })
);
const vaultHumanTransitKeyResponse = vaultMachineCodec(
	z.object({ key: vaultHumanTransitKey })
);
const vaultHumanDeletedEngine = vaultMachineCodec(
	z.object({ deleted: z.boolean() })
);
type VaultHumanTransitCodecs = {
	[Op in VaultTransitOperation]: z.ZodType<
		VaultTransitOperations[Op]["result"]
	>;
};
const vaultHumanTransitResponses: VaultHumanTransitCodecs = {
	...vaultMachineTransitResponses,
	rotate: vaultHumanTransitKeyResponse,
};
const vaultHumanPkiIssuer = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		commonName: vaultHumanText,
		certificate: vaultHumanText,
		notAfter: vaultHumanTimestamp,
	})
);
const vaultHumanPkiIssuers = vaultMachineCodec(
	z.object({ issuers: z.array(vaultHumanPkiIssuer) })
);
const vaultHumanPkiIssuerResponse = vaultMachineCodec(
	z.object({ issuer: vaultHumanPkiIssuer })
);
const vaultHumanPkiRole = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		issuer: vaultHumanText,
		allowedDomains: z.array(vaultHumanText),
		allowIpSans: z.boolean(),
		defaultTtlSecs: vaultHumanNumber,
		maxTtlSecs: vaultHumanNumber,
		serverFlag: z.boolean(),
		clientFlag: z.boolean(),
	})
);
const vaultHumanPkiRoles = vaultMachineCodec(
	z.object({ roles: z.array(vaultHumanPkiRole) })
);
const vaultHumanPkiRoleResponse = vaultMachineCodec(
	z.object({ role: vaultHumanPkiRole })
);
const vaultHumanPkiRecord = vaultMachineCodec(
	z.object({
		serial: vaultHumanText,
		issuer: vaultHumanText,
		commonName: vaultHumanText,
		notAfter: vaultHumanTimestamp,
		revokedAt: vaultHumanTimestamp.nullable(),
	})
);
const vaultHumanPkiRecords = vaultMachineCodec(
	z.object({ certificates: z.array(vaultHumanPkiRecord) })
);
const vaultHumanPkiRecordResponse = vaultMachineCodec(
	z.object({ certificate: vaultHumanPkiRecord })
);
const vaultHumanSshCa = vaultMachineCodec(
	z.object({ name: vaultHumanText, publicKey: vaultHumanText })
);
const vaultHumanSshCas = vaultMachineCodec(
	z.object({ cas: z.array(vaultHumanSshCa) })
);
const vaultHumanSshPublicKey = vaultMachineCodec(
	z.object({ publicKey: vaultHumanText })
);
const vaultHumanSshRole = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		ca: vaultHumanText,
		certType: z.enum(["user", "host"]),
		allowedPrincipals: z.array(vaultHumanText),
		defaultTtlSecs: vaultHumanNumber,
		maxTtlSecs: vaultHumanNumber,
		extensions: z.array(vaultHumanText),
	})
);
const vaultHumanSshRoles = vaultMachineCodec(
	z.object({ roles: z.array(vaultHumanSshRole) })
);
const vaultHumanSshRoleResponse = vaultMachineCodec(
	z.object({ role: vaultHumanSshRole })
);
const vaultHumanDynamicRole = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		provider: vaultHumanText,
		defaultTtlSecs: vaultHumanNumber,
		maxTtlSecs: vaultHumanNumber,
		summary: appJsonValueSchema,
		createdAt: vaultHumanTimestamp,
		updatedAt: vaultHumanTimestamp,
	})
);
const vaultHumanDynamicRoles = vaultMachineCodec(
	z.object({ roles: z.array(vaultHumanDynamicRole) })
);
const vaultHumanDynamicRoleResponse = vaultMachineCodec(
	z.object({ role: vaultHumanDynamicRole })
);
const vaultHumanRevokedCount = vaultMachineCodec(
	z.object({ revoked: vaultHumanNumber })
);
const vaultHumanLeases = vaultMachineCodec(
	z.object({ leases: z.array(vaultMachineLease) })
);
const vaultHumanJwtClaimValues = z.array(vaultHumanText);
const vaultHumanJwtClaimsFields = z.record(
	vaultHumanText,
	vaultHumanJwtClaimValues
);
const vaultHumanJwtClaims = z.custom<
	z.output<typeof vaultHumanJwtClaimsFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		vaultHumanJwtClaimsFields.safeParse(value).success &&
		Object.entries(Object.call(undefined, value)).every(
			([, entry]) => vaultHumanJwtClaimValues.safeParse(entry).success
		)
);
// The internally tagged enum renames variants, not AppRole's struct fields.
const vaultHumanMachineAuth = vaultMachineCodec(
	z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("approle"), role_id: vaultHumanText }),
		z.object({
			kind: z.literal("jwt"),
			issuer: vaultHumanText,
			jwksUrl: vaultHumanText.nullable(),
			publicKeyPem: vaultHumanText.nullable(),
			audiences: z.array(vaultHumanText),
			boundClaims: vaultHumanJwtClaims,
		}),
	])
);
const vaultHumanMachine = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		name: vaultHumanText,
		auth: vaultHumanMachineAuth,
		policies: z.array(vaultHumanText),
		tokenTtlSecs: vaultHumanNumber,
		disabled: z.boolean(),
		createdAt: vaultHumanTimestamp,
		createdBy: vaultHumanText.nullable(),
	})
);
const vaultHumanMachines = vaultMachineCodec(
	z.object({ machines: z.array(vaultHumanMachine) })
);
const vaultHumanMachineResponse = vaultMachineCodec(
	z.object({ machine: vaultHumanMachine })
);
const vaultHumanSecretId = vaultMachineCodec(
	z.object({
		accessor: vaultHumanText,
		createdAt: vaultHumanTimestamp,
		expiresAt: vaultHumanTimestamp.nullable(),
		usesRemaining: vaultHumanNumber.nullable(),
	})
);
const vaultHumanSecretIds = vaultMachineCodec(
	z.object({ secretIds: z.array(vaultHumanSecretId) })
);
const vaultHumanIssuedSecretId = vaultMachineCodec(
	z.object({ secretId: vaultHumanText, info: vaultHumanSecretId })
);

export interface VaultReference {
	environment?: string;
	name: string;
	path?: string;
}

const ENV_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FOLDER_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FOLDER_DEPTH = 8;

/** Parse `NAME`, `/folder/NAME`, `ENV:NAME`, or `ENV:/folder/NAME` (the
 *  `secret:` prefix is optional). Returns null when it does not parse. */
export function parseVaultReference(input: string): VaultReference | null {
	let rest = input.trim();
	if (rest.startsWith("secret:")) {
		rest = rest.slice("secret:".length);
	}
	let environment: string | undefined;
	const colon = rest.indexOf(":");
	if (colon !== -1) {
		environment = rest.slice(0, colon);
		rest = rest.slice(colon + 1);
		if (!ENV_SLUG.test(environment)) {
			return null;
		}
	}
	let path: string | undefined;
	if (rest.startsWith("/")) {
		const segments = rest.split("/").slice(1);
		const name = segments.pop() ?? "";
		if (
			segments.length > MAX_FOLDER_DEPTH ||
			!segments.every((segment) => FOLDER_SEGMENT.test(segment))
		) {
			return null;
		}
		path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
		rest = name;
	}
	if (!SECRET_NAME.test(rest)) {
		return null;
	}
	const reference: VaultReference = { name: rest };
	if (environment !== undefined) {
		reference.environment = environment;
	}
	if (path !== undefined) {
		reference.path = path;
	}
	return reference;
}
