// packages/core-client/src/vault/shared.ts
//
// Shared vocabulary: part of the Secret Vault client. `../vault.ts` re-exports
// these names and documents the wire conventions.

import type { VaultValueType } from "./value-types.ts";

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
	/**
	 * How sensitive the value is. Core and the control plane send it for every
	 * value; read it with `vaultValueType`, which applies the defaults.
	 */
	valueType?: VaultValueType;
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
	/** Omit to keep the stored type. Sealing is one-way. */
	valueType?: VaultValueType;
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
