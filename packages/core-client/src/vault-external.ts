// External secret stores and secret syncs (`/api/vault/external/*`).
//
// A store is a connection to OpenBao, HashiCorp Vault, or Infisical, or a
// push-only sync target (GitHub Actions, Vercel, AWS Secrets Manager, Google
// Cloud Secret Manager). Sources pull a remote path into a node folder;
// destinations push a node folder out. Core never returns store credentials
// or secret values on these routes: credentials go in on create only.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

export type VaultExternalStoreKind =
	| "openbao"
	| "hashicorp-vault"
	| "infisical"
	| "github-actions"
	| "vercel"
	| "aws-secrets-manager"
	| "gcp-secret-manager";

export type VaultExternalAuthMethod =
	| "token"
	| "approle"
	| "kubernetes"
	| "universal-auth"
	| "access-key"
	| "service-account";

/** Kinds that only accept destinations (secret syncs). */
export const VAULT_SYNC_TARGET_KINDS: readonly VaultExternalStoreKind[] = [
	"github-actions",
	"vercel",
	"aws-secrets-manager",
	"gcp-secret-manager",
];

/** Whether `kind` is a push-only sync target. */
export function isVaultSyncTarget(kind: string): boolean {
	return (VAULT_SYNC_TARGET_KINDS as readonly string[]).includes(kind);
}

/** The auth methods Core accepts for each kind. */
export const VAULT_EXTERNAL_AUTH_METHODS: Record<
	VaultExternalStoreKind,
	readonly VaultExternalAuthMethod[]
> = {
	openbao: ["token", "approle", "kubernetes"],
	"hashicorp-vault": ["token", "approle", "kubernetes"],
	infisical: ["token", "universal-auth"],
	"github-actions": ["token"],
	vercel: ["token"],
	"aws-secrets-manager": ["access-key"],
	"gcp-secret-manager": ["service-account", "token"],
};

/** Write-only store credentials. Never returned by Core. */
export interface VaultExternalCredentials {
	accessKeyId?: string;
	clientId?: string;
	clientSecret?: string;
	roleId?: string;
	secretAccessKey?: string;
	secretId?: string;
	/** A Google Cloud service-account key file's JSON text. */
	serviceAccountKey?: string;
	sessionToken?: string;
	token?: string;
}

/** Settings only sync targets use. */
export interface VaultSyncTargetOptions {
	githubEnvironment?: string;
	region?: string;
	/** GitHub `owner/repo`. */
	repository?: string;
	teamId?: string;
	vercelTargets?: string[];
}

export interface VaultExternalStoreInput extends VaultSyncTargetOptions {
	/** Optional for sync targets (defaults to the platform's public API). */
	address?: string;
	authMethod: VaultExternalAuthMethod;
	authMount?: string;
	credentials: VaultExternalCredentials;
	infisicalEnvironment?: string;
	kind: VaultExternalStoreKind;
	kvVersion?: 1 | 2;
	mount?: string;
	name: string;
	namespace?: string;
	pathPrefix?: string;
	projectId?: string;
	role?: string;
	secretPath?: string;
}

export interface VaultExternalStore extends VaultSyncTargetOptions {
	address: string;
	authMethod: VaultExternalAuthMethod;
	createdAt: number;
	id: string;
	kind: VaultExternalStoreKind;
	mount: string;
	name: string;
	pathPrefix: string;
	projectId: string;
	updatedAt: number;
}

export interface VaultExternalSourceInput {
	cacheTtlSecs?: number;
	environment: string;
	mode: "live" | "sync";
	path: string;
	remotePath?: string;
	staleIfErrorSecs?: number;
	storeId: string;
	syncIntervalSecs?: number;
}

export interface VaultExternalSource {
	environment: string;
	id: string;
	lastCount: number;
	lastError: string | null;
	lastStatus: string | null;
	lastSyncAt: number | null;
	mode: "live" | "sync";
	path: string;
	remotePath: string;
	storeId: string;
	syncIntervalSecs: number;
}

export interface VaultExternalDestinationInput {
	environment: string;
	intervalSecs?: number;
	path: string;
	/** A name prefix for GitHub, Vercel and Google Cloud; the secret name for AWS and KV stores. */
	remotePath?: string;
	storeId: string;
}

export interface VaultExternalDestination {
	dirty: boolean;
	environment: string;
	failures: number;
	id: string;
	intervalSecs: number;
	lastCount: number;
	lastError: string | null;
	lastPushAt: number | null;
	lastStatus: string | null;
	path: string;
	remotePath: string;
	storeId: string;
}

export interface VaultExternalSyncReport {
	removed: number;
	unchanged: number;
	written: number;
}

const text = z.string();
const count = z.number();
const maybeText = z.string().nullable();
const maybeCount = z.number().nullable();

const storeFields = z.object({
	id: text,
	name: text,
	kind: text,
	address: text,
	authMethod: text,
});
const sourceFields = z.object({
	id: text,
	storeId: text,
	environment: text,
	path: text,
	mode: z.enum(["live", "sync"]),
	lastStatus: maybeText,
	lastSyncAt: maybeCount,
});
const destinationFields = z.object({
	id: text,
	storeId: text,
	environment: text,
	path: text,
	remotePath: text,
	dirty: z.boolean(),
	failures: count,
	lastStatus: maybeText,
	lastPushAt: maybeCount,
});

/** Validate the fields callers read and keep the whole decoded object. */
function reply<T>(fields: z.ZodType): z.ZodType<T> {
	return z.custom<T>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

const storesReply = reply<{ stores: VaultExternalStore[] }>(
	z.object({ stores: z.array(storeFields) })
);
const storeReply = reply<{ store: VaultExternalStore }>(
	z.object({ store: storeFields })
);
const sourcesReply = reply<{ sources: VaultExternalSource[] }>(
	z.object({ sources: z.array(sourceFields) })
);
const sourceReply = reply<{ source: VaultExternalSource }>(
	z.object({ source: sourceFields })
);
const destinationsReply = reply<{ destinations: VaultExternalDestination[] }>(
	z.object({ destinations: z.array(destinationFields) })
);
const destinationReply = reply<{ destination: VaultExternalDestination }>(
	z.object({ destination: destinationFields })
);
const deletedReply = reply<{ deleted: boolean }>(
	z.object({ deleted: z.boolean() })
);
const testReply = reply<{ error?: string; ok: boolean }>(
	z.object({ ok: z.boolean(), error: text.optional() })
);
const syncReply = reply<{ report: VaultExternalSyncReport }>(
	z.object({
		report: z.object({ written: count, removed: count, unchanged: count }),
	})
);
const pushReply = reply<{ pushed: number }>(z.object({ pushed: count }));

const BASE = "/api/vault/external";
const id = (value: string) => encodeURIComponent(value);

export function listVaultExternalStores(
	target: ApiTarget
): Promise<{ stores: VaultExternalStore[] }> {
	return request(target, `${BASE}/stores`, {}, storesReply);
}

export function createVaultExternalStore(
	target: ApiTarget,
	input: VaultExternalStoreInput
): Promise<{ store: VaultExternalStore }> {
	return request(
		target,
		`${BASE}/stores`,
		{ method: "POST", body: input },
		storeReply
	);
}

export function deleteVaultExternalStore(
	target: ApiTarget,
	storeId: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`${BASE}/stores/${id(storeId)}`,
		{ method: "DELETE" },
		deletedReply
	);
}

/** Check connectivity and credentials. A store that answers but refuses is `ok: false`. */
export function testVaultExternalStore(
	target: ApiTarget,
	storeId: string
): Promise<{ error?: string; ok: boolean }> {
	return request(
		target,
		`${BASE}/stores/${id(storeId)}/test`,
		{ method: "POST" },
		testReply
	);
}

export function listVaultExternalSources(
	target: ApiTarget
): Promise<{ sources: VaultExternalSource[] }> {
	return request(target, `${BASE}/sources`, {}, sourcesReply);
}

export function createVaultExternalSource(
	target: ApiTarget,
	input: VaultExternalSourceInput
): Promise<{ source: VaultExternalSource }> {
	return request(
		target,
		`${BASE}/sources`,
		{ method: "POST", body: input },
		sourceReply
	);
}

export function deleteVaultExternalSource(
	target: ApiTarget,
	sourceId: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`${BASE}/sources/${id(sourceId)}`,
		{ method: "DELETE" },
		deletedReply
	);
}

export function syncVaultExternalSource(
	target: ApiTarget,
	sourceId: string
): Promise<{ report: VaultExternalSyncReport }> {
	return request(
		target,
		`${BASE}/sources/${id(sourceId)}/sync`,
		{ method: "POST" },
		syncReply
	);
}

export function listVaultExternalDestinations(
	target: ApiTarget
): Promise<{ destinations: VaultExternalDestination[] }> {
	return request(target, `${BASE}/destinations`, {}, destinationsReply);
}

export function createVaultExternalDestination(
	target: ApiTarget,
	input: VaultExternalDestinationInput
): Promise<{ destination: VaultExternalDestination }> {
	return request(
		target,
		`${BASE}/destinations`,
		{ method: "POST", body: input },
		destinationReply
	);
}

export function deleteVaultExternalDestination(
	target: ApiTarget,
	destinationId: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`${BASE}/destinations/${id(destinationId)}`,
		{ method: "DELETE" },
		deletedReply
	);
}

/** Push a destination now. Returns how many keys were pushed. */
export function pushVaultExternalDestination(
	target: ApiTarget,
	destinationId: string
): Promise<{ pushed: number }> {
	return request(
		target,
		`${BASE}/destinations/${id(destinationId)}/push`,
		{ method: "POST" },
		pushReply
	);
}
