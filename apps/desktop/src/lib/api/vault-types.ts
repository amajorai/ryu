// Desktop-facing shapes of the Core vault surface (`/api/vault/*`), re-exported
// by `vault.ts`. Listings carry metadata only, never values.
// test-exempt: type declarations only; vault.test.ts exercises the calls that use them.

import type { AppResponseValue } from "@ryuhq/core-client/app-request-json.ts";
import type {
	VaultCallerContext,
	VaultCapability,
	VaultChangeStatus,
	VaultEnvironment,
	VaultExportFormat,
	VaultNodeContext,
	VaultScope,
	VaultSealStatus,
	VaultSecretStatus,
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
	/** Include this organization project's values (P1-15). */
	projectId?: string;
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
