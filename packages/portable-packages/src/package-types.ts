import type { z } from "zod";
import type { ConnectionRequirement } from "./connection-requirements.ts";

export const PACKAGE_MANIFEST_FILE = "ryu.package.json";
export const PACKAGE_ARCHIVE_EXTENSION = ".ryupack";
export const PACKAGE_SCHEMA_VERSION = 1 as const;
export const SECRETS_FILE = "secrets.enc";

export const PACKAGE_KINDS = [
	"plugin",
	"app",
	"skill",
	"agent",
	"workflow",
	"theme",
	"output_style",
	"space",
	"profile",
	"bundle",
	"language_pack",
] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

export const PACKAGE_SCOPES = [
	"desktop",
	"node",
	"gateway",
	"agent",
	"space",
	"workflow",
] as const;
export type PackageScope = (typeof PACKAGE_SCOPES)[number];

export interface PackageSource {
	checksum?: string;
	commit?: string;
	path?: string;
	ref?: string;
	repository?: string;
	type: "github" | "local" | "archive";
}

export interface PackageSecurity {
	containsSecrets: boolean;
	permissions: string[];
	privateContent: boolean;
	redacted: boolean;
}

/** The listing a remix was copied from, credited on the remix's own listing. */
export interface PackageRemixSource {
	id: string;
	kind: string;
	version?: string;
}

export interface RyuPackageManifest {
	$schema?: string;
	/**
	 * Whether others may remix (copy, edit and republish) this package. Absent
	 * means allowed; only an explicit `false` opts out. See `packageAllowsRemix`.
	 */
	allowRemix?: boolean;
	artifacts: string[];
	capabilities: string[];
	/** Declarative setup requirements; never contains credentials or connection state. */
	connectionRequirements?: ConnectionRequirement[];
	id: string;
	includes?: string[];
	kind: PackageKind;
	/** Safe presentation metadata carried into marketplace listings. */
	metadata?: Record<string, z.core.util.JSONType>;
	name: string;
	/** The listing this package was remixed from, when it is a remix. */
	remixedFrom?: PackageRemixSource;
	requires: Record<string, string>;
	schemaVersion: typeof PACKAGE_SCHEMA_VERSION;
	/** Export scopes this package can safely apply. */
	scopes: PackageScope[];
	security: PackageSecurity;
	source?: PackageSource;
	targets: string[];
	version: string;
}

export interface PackageTree {
	files: Record<string, Uint8Array>;
	manifest: RyuPackageManifest;
}

export interface PackageValidationIssue {
	message: string;
	path: string;
}

export class PackageValidationError extends Error {
	readonly issues: PackageValidationIssue[];

	constructor(issues: PackageValidationIssue[]) {
		super(
			issues.length === 1
				? `Invalid Ryu package: ${issues[0]?.message ?? "unknown error"}`
				: `Invalid Ryu package (${issues.length} errors)`
		);
		this.name = "PackageValidationError";
		this.issues = issues;
	}
}

export interface PackageChange {
	baseDigest: string | null;
	localDigest: string | null;
	path: string;
	secret: boolean;
	status: "added" | "modified" | "removed" | "unchanged" | "conflict";
	upstreamDigest: string | null;
}

export interface PackageUpdateDiff {
	changes: PackageChange[];
	conflicts: string[];
	merged: PackageTree | null;
}

export interface SecretEnvelope {
	algorithm: "aes-256-gcm";
	ciphertext: string;
	kdf: "scrypt";
	nonce: string;
	packageId: string;
	packageVersion: string;
	salt: string;
	tag: string;
	version: 1;
}

export interface ResolvedGithubPackage {
	commit: string;
	source: PackageSource;
	tree: PackageTree;
}

export interface GithubPackageReference {
	path: string;
	ref: string;
	repository: string;
}

export type PackageFetcher = (
	input: string,
	init?: { headers?: Record<string, string> }
) => Promise<Response>;

export const MAX_PACKAGE_FILES = 2048;
export const MAX_PACKAGE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_PACKAGE_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_PACKAGE_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_GITHUB_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_GITHUB_TREE_REQUESTS = MAX_PACKAGE_FILES * 2;
