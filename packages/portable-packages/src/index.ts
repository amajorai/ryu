import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	scryptSync,
} from "node:crypto";
import {
	access,
	lstat,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { unzipSync, type Zippable, zipSync } from "fflate";
import {
	CONNECTION_REQUIREMENT_FIELDS,
	type ConnectionRequirement,
	ConnectionRequirementValidationError,
	normalizePackageConnectionRequirements,
} from "./connection-requirements.ts";

export * from "./connection-requirements.ts";

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

export interface RyuPackageManifest {
	$schema?: string;
	artifacts: string[];
	capabilities: string[];
	/** Declarative setup requirements; never contains credentials or connection state. */
	connectionRequirements?: ConnectionRequirement[];
	id: string;
	includes?: string[];
	kind: PackageKind;
	/** Safe presentation metadata carried into marketplace listings. */
	metadata?: Record<string, unknown>;
	name: string;
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

type PackageFetcher = (
	input: string,
	init?: { headers?: Record<string, string> }
) => Promise<Response>;

const SECRET_PREFIX = "RYU-SECRETS-V1\n";
const SECRET_KEY_BYTES = 32;
const SECRET_NONCE_BYTES = 12;
const SECRET_SALT_BYTES = 16;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SECRET_AAD_PREFIX = "ryu.portable-package.secrets.v1:";
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const MAX_PACKAGE_FILES = 2048;
const MAX_PACKAGE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_GITHUB_JSON_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_TREE_REQUESTS = MAX_PACKAGE_FILES * 2;

const SENSITIVE_FILE_RE =
	/(^|\/)(?:\.env(?:\..*)?|secrets?\.(?:json|ya?ml)|credentials?\.(?:json|ya?ml)|.*\.(?:pem|key|p12|pfx))$/i;
const PRIVATE_CONTENT_RE = /^(?:content|documents|private)(?:\/|$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedResponseBytes(
	response: Response,
	maxBytes: number,
	errorMessage: string
): Promise<Uint8Array> {
	const contentLength = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new Error(errorMessage);
	}
	if (!response.body) {
		const data = new Uint8Array(await response.arrayBuffer());
		if (data.byteLength > maxBytes) {
			throw new Error(errorMessage);
		}
		return data;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error(errorMessage);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const data = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return data;
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function cleanStringArray(value: unknown): string[] {
	return isStringArray(value)
		? value.map((item) => item.trim()).filter(Boolean)
		: [];
}

function normalizePath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		normalized.split("/").some((part) => part === ".." || part === "")
	) {
		throw new PackageValidationError([
			{ path: "files", message: `unsafe package path: ${path}` },
		]);
	}
	return normalized;
}

function stringField(
	value: unknown,
	path: string,
	issues: PackageValidationIssue[]
): string {
	if (typeof value !== "string" || value.trim() === "") {
		issues.push({ path, message: "must be a non-empty string" });
		return "";
	}
	return value.trim();
}

function packageSecurity(value: unknown): PackageSecurity {
	if (!isRecord(value)) {
		return {
			containsSecrets: false,
			permissions: [],
			privateContent: false,
			redacted: false,
		};
	}
	return {
		containsSecrets: value.containsSecrets === true,
		permissions: cleanStringArray(value.permissions),
		privateContent: value.privateContent === true,
		redacted: value.redacted === true,
	};
}

function packageSource(value: unknown): PackageSource | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const type = value.type;
	if (type !== "github" && type !== "local" && type !== "archive") {
		return undefined;
	}
	const source: PackageSource = { type };
	for (const key of [
		"repository",
		"path",
		"ref",
		"commit",
		"checksum",
	] as const) {
		if (typeof value[key] === "string" && value[key].trim()) {
			source[key] = value[key].trim();
		}
	}
	return source;
}

export function validatePackageManifest(value: unknown): RyuPackageManifest {
	const issues: PackageValidationIssue[] = [];
	if (!isRecord(value)) {
		throw new PackageValidationError([
			{ path: PACKAGE_MANIFEST_FILE, message: "must contain a JSON object" },
		]);
	}
	const schemaVersion = value.schemaVersion;
	if (schemaVersion !== PACKAGE_SCHEMA_VERSION) {
		issues.push({
			path: "schemaVersion",
			message: `must be ${PACKAGE_SCHEMA_VERSION}`,
		});
	}
	const kind = value.kind;
	if (!PACKAGE_KINDS.includes(kind as PackageKind)) {
		issues.push({
			path: "kind",
			message: `must be one of ${PACKAGE_KINDS.join(", ")}`,
		});
	}
	const id = stringField(value.id, "id", issues);
	if (
		id &&
		(!/^[a-zA-Z0-9@._/-]+$/.test(id) ||
			id.split("/").some((part) => part === "." || part === ".."))
	) {
		issues.push({ path: "id", message: "contains unsupported characters" });
	}
	const name = stringField(value.name, "name", issues);
	const version = stringField(value.version, "version", issues);
	if (version && !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
		issues.push({ path: "version", message: "must be a semver-like version" });
	}
	const artifacts = cleanStringArray(value.artifacts);
	const targets = cleanStringArray(value.targets);
	const scopes = cleanStringArray(value.scopes).filter(
		(scope): scope is PackageScope =>
			PACKAGE_SCOPES.includes(scope as PackageScope)
	);
	const requirements: Record<string, string> = {};
	if (isRecord(value.requires)) {
		for (const [key, item] of Object.entries(value.requires)) {
			if (key.trim() && typeof item === "string") {
				requirements[key] = item;
			}
		}
	}
	const capabilities = cleanStringArray(value.capabilities);
	const hasConnectionRequirements = CONNECTION_REQUIREMENT_FIELDS.some(
		(field) => Object.hasOwn(value, field)
	);
	let connectionRequirements: ConnectionRequirement[] | undefined;
	if (hasConnectionRequirements) {
		try {
			connectionRequirements = normalizePackageConnectionRequirements(value);
		} catch (error) {
			if (error instanceof ConnectionRequirementValidationError) {
				issues.push(
					...error.issues.map((issue) => ({
						path: `connectionRequirements.${issue.path}`,
						message: issue.message,
					}))
				);
			} else {
				issues.push({
					path: "connectionRequirements",
					message: "could not be normalized",
				});
			}
		}
	}
	if (!isStringArray(value.artifacts)) {
		issues.push({ path: "artifacts", message: "must be an array of strings" });
	}
	if (!isStringArray(value.targets)) {
		issues.push({ path: "targets", message: "must be an array of strings" });
	}
	if (!isStringArray(value.scopes)) {
		issues.push({ path: "scopes", message: "must be an array of strings" });
	}
	for (const path of artifacts) {
		try {
			normalizePath(path);
		} catch {
			issues.push({
				path: "artifacts",
				message: `unsafe artifact path: ${path}`,
			});
		}
	}
	if (scopes.length !== cleanStringArray(value.scopes).length) {
		issues.push({ path: "scopes", message: "contains an unsupported scope" });
	}
	if (issues.length > 0) {
		throw new PackageValidationError(issues);
	}
	return {
		$schema: typeof value.$schema === "string" ? value.$schema : undefined,
		artifacts,
		capabilities,
		id,
		includes: cleanStringArray(value.includes),
		kind: kind as PackageKind,
		name,
		requires: requirements,
		schemaVersion: PACKAGE_SCHEMA_VERSION,
		security: packageSecurity(value.security),
		source: packageSource(value.source),
		targets,
		version,
		scopes,
		metadata: isRecord(value.metadata) ? value.metadata : undefined,
		...(hasConnectionRequirements
			? { connectionRequirements: connectionRequirements ?? [] }
			: {}),
	};
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalize(value[key])])
	);
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function manifestBytes(manifest: RyuPackageManifest): Uint8Array {
	return new TextEncoder().encode(`${canonicalJson(manifest)}\n`);
}

function digestBytes(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function digestFile(data: Uint8Array): string {
	return digestBytes(data);
}

export function packageDigest(tree: PackageTree): string {
	const hash = createHash("sha256");
	hash.update(manifestBytes(tree.manifest));
	for (const path of Object.keys(tree.files).sort()) {
		const normalized = normalizePath(path);
		const data = tree.files[path];
		if (!data) {
			continue;
		}
		hash.update(
			new TextEncoder().encode(`${normalized}\0${data.byteLength}\0`)
		);
		hash.update(data);
	}
	return hash.digest("hex");
}

function isSensitivePath(path: string): boolean {
	return path === SECRETS_FILE || SENSITIVE_FILE_RE.test(path);
}

function isPrivateContentPath(path: string): boolean {
	return PRIVATE_CONTENT_RE.test(path);
}

export function redactPackageTree(
	tree: PackageTree,
	options: { includePrivateContent?: boolean } = {}
): PackageTree {
	const files: Record<string, Uint8Array> = {};
	for (const [path, data] of Object.entries(tree.files)) {
		if (isSensitivePath(path)) {
			continue;
		}
		if (!options.includePrivateContent && isPrivateContentPath(path)) {
			continue;
		}
		files[path] = data;
	}
	return {
		files,
		manifest: {
			...tree.manifest,
			security: {
				...tree.manifest.security,
				containsSecrets: false,
				privateContent: Object.keys(files).some(isPrivateContentPath),
				redacted: true,
			},
		},
	};
}

function bytesFromString(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function stringFromBytes(value: Uint8Array): string {
	return new TextDecoder().decode(value);
}

function packageAad(manifest: RyuPackageManifest): Buffer {
	return Buffer.from(
		`${SECRET_AAD_PREFIX}${manifest.id}:${manifest.version}`,
		"utf8"
	);
}

export function encryptSecrets(
	value: unknown,
	passphrase: string,
	manifest: Pick<RyuPackageManifest, "id" | "version">
): Uint8Array {
	if (!passphrase) {
		throw new Error("A passphrase is required to encrypt package secrets");
	}
	const salt = randomBytes(SECRET_SALT_BYTES);
	const nonce = randomBytes(SECRET_NONCE_BYTES);
	const key = scryptSync(passphrase, salt, SECRET_KEY_BYTES, {
		maxmem: 64 * 1024 * 1024,
		N: SCRYPT_N,
		p: SCRYPT_P,
		r: SCRYPT_R,
	});
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const aad = packageAad(manifest as RyuPackageManifest);
	cipher.setAAD(aad);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(value), "utf8"),
		cipher.final(),
	]);
	const envelope: SecretEnvelope = {
		algorithm: "aes-256-gcm",
		ciphertext: ciphertext.toString("base64url"),
		kdf: "scrypt",
		nonce: nonce.toString("base64url"),
		packageId: manifest.id,
		packageVersion: manifest.version,
		salt: salt.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
		version: 1,
	};
	return bytesFromString(`${SECRET_PREFIX}${canonicalJson(envelope)}\n`);
}

export function decryptSecrets(
	data: Uint8Array,
	passphrase: string,
	manifest: Pick<RyuPackageManifest, "id" | "version">
): unknown {
	if (!passphrase) {
		throw new Error("A passphrase is required to decrypt package secrets");
	}
	const raw = stringFromBytes(data);
	if (!raw.startsWith(SECRET_PREFIX)) {
		throw new Error("Unsupported package secret envelope");
	}
	const remainder = raw.slice(SECRET_PREFIX.length).trim();
	let envelope: SecretEnvelope;
	try {
		envelope = JSON.parse(remainder) as SecretEnvelope;
	} catch {
		throw new Error("Malformed package secret envelope");
	}
	if (
		envelope.version !== 1 ||
		envelope.algorithm !== "aes-256-gcm" ||
		envelope.kdf !== "scrypt" ||
		envelope.packageId !== manifest.id ||
		envelope.packageVersion !== manifest.version
	) {
		throw new Error(
			"Package secret envelope does not match the package manifest"
		);
	}
	const salt = Buffer.from(envelope.salt, "base64url");
	const nonce = Buffer.from(envelope.nonce, "base64url");
	const tag = Buffer.from(envelope.tag, "base64url");
	const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
	const key = scryptSync(passphrase, salt, SECRET_KEY_BYTES, {
		maxmem: 64 * 1024 * 1024,
		N: SCRYPT_N,
		p: SCRYPT_P,
		r: SCRYPT_R,
	});
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAAD(packageAad(manifest as RyuPackageManifest));
	decipher.setAuthTag(tag);
	try {
		const plaintext = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]).toString("utf8");
		return JSON.parse(plaintext) as unknown;
	} catch {
		throw new Error(
			"Unable to decrypt package secrets: the unlock key is incorrect"
		);
	}
}

export function hasEncryptedSecrets(tree: PackageTree): boolean {
	return SECRETS_FILE in tree.files;
}

export function withEncryptedSecrets(
	tree: PackageTree,
	value: unknown,
	passphrase: string
): PackageTree {
	return {
		files: {
			...tree.files,
			[SECRETS_FILE]: encryptSecrets(value, passphrase, tree.manifest),
		},
		manifest: {
			...tree.manifest,
			security: {
				...tree.manifest.security,
				containsSecrets: true,
				privateContent: true,
				redacted: false,
			},
		},
	};
}

function equalBytes(
	left: Uint8Array | undefined,
	right: Uint8Array | undefined
): boolean {
	if (!(left && right) || left.byteLength !== right.byteLength) {
		return left === right;
	}
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

function mergeJsonValue(
	base: unknown,
	local: unknown,
	upstream: unknown,
	path: string,
	conflicts: string[]
): unknown {
	if (canonicalJson(local) === canonicalJson(base)) {
		return upstream;
	}
	if (canonicalJson(upstream) === canonicalJson(base)) {
		return local;
	}
	if (canonicalJson(local) === canonicalJson(upstream)) {
		return local;
	}
	if (isRecord(base) && isRecord(local) && isRecord(upstream)) {
		const keys = new Set([
			...Object.keys(base),
			...Object.keys(local),
			...Object.keys(upstream),
		]);
		const result: Record<string, unknown> = {};
		for (const key of [...keys].sort()) {
			const merged = mergeJsonValue(
				base[key],
				local[key],
				upstream[key],
				`${path}.${key}`,
				conflicts
			);
			if (merged !== undefined) {
				result[key] = merged;
			}
		}
		return result;
	}
	if (Array.isArray(base) && Array.isArray(local) && Array.isArray(upstream)) {
		const setLike = /(?:^|\.)?(?:tools|skills)$/.test(path);
		if (!setLike) {
			// Arrays such as workflow nodes and ordered rules carry meaning in their
			// position. Do not turn an ordered array into an object-keyed set merely
			// because its members happen to expose an id or name.
			conflicts.push(path);
			return local;
		}
		const arrayKey = (item: unknown): string | null => {
			if (!isRecord(item)) {
				return null;
			}
			for (const key of ["id", "name", "key", "slug"]) {
				if (typeof item[key] === "string" && item[key].length > 0) {
					return `${key}:${item[key]}`;
				}
			}
			return null;
		};
		const keyed = [base, local, upstream].every((items) =>
			items.every((item) => arrayKey(item) !== null)
		);
		if (keyed) {
			const byId = (items: unknown[]) =>
				new Map(items.map((item) => [arrayKey(item) as string, item]));
			const baseById = byId(base);
			const localById = byId(local);
			const upstreamById = byId(upstream);
			const ids = new Set([
				...baseById.keys(),
				...localById.keys(),
				...upstreamById.keys(),
			]);
			const result: unknown[] = [];
			for (const id of [...ids].sort()) {
				const merged = mergeJsonValue(
					baseById.get(id),
					localById.get(id),
					upstreamById.get(id),
					`${path}[${id}]`,
					conflicts
				);
				if (merged !== undefined) {
					result.push(merged);
				}
			}
			return result;
		}
		if (
			[base, local, upstream].every((items) =>
				items.every((item) =>
					["string", "number", "boolean"].includes(typeof item)
				)
			)
		) {
			// Tool and skill lists are set-like agent configuration. When both sides
			// add entries, preserve both additions instead of turning an otherwise
			// safe update into a conflict. Object arrays use stable ids/names above.
			const values = new Map<string, unknown>();
			for (const item of [...local, ...upstream]) {
				values.set(`${typeof item}:${String(item)}`, item);
			}
			return [...values.values()].sort((left, right) =>
				String(left).localeCompare(String(right))
			);
		}
	}
	conflicts.push(path);
	return local;
}

function parseJsonFile(data: Uint8Array | undefined): unknown | undefined {
	if (!data) {
		return undefined;
	}
	try {
		return JSON.parse(stringFromBytes(data)) as unknown;
	} catch {
		return undefined;
	}
}

function mergeFile(
	path: string,
	base: Uint8Array | undefined,
	local: Uint8Array | undefined,
	upstream: Uint8Array | undefined,
	conflicts: string[]
): Uint8Array | undefined {
	if (isSensitivePath(path)) {
		// A credentials/secrets change is never auto-applied, even when the local
		// package did not edit that file. The caller must explicitly unlock and
		// resolve it outside the package update merge.
		if (!equalBytes(base, upstream)) {
			conflicts.push(path);
		}
		return local;
	}
	if (equalBytes(local, base)) {
		return upstream;
	}
	if (equalBytes(upstream, base) || equalBytes(local, upstream)) {
		return local;
	}
	if (path.endsWith(".json")) {
		const baseJson = parseJsonFile(base);
		const localJson = parseJsonFile(local);
		const upstreamJson = parseJsonFile(upstream);
		if (localJson !== undefined && upstreamJson !== undefined) {
			const merged = mergeJsonValue(
				baseJson,
				localJson,
				upstreamJson,
				path,
				conflicts
			);
			return bytesFromString(`${JSON.stringify(merged, null, 2)}\n`);
		}
	}
	conflicts.push(path);
	return local;
}

export function diffPackageTrees(
	base: PackageTree,
	local: PackageTree,
	upstream: PackageTree
): PackageUpdateDiff {
	const paths = new Set([
		...Object.keys(base.files),
		...Object.keys(local.files),
		...Object.keys(upstream.files),
	]);
	const changes: PackageChange[] = [];
	const conflicts: string[] = [];
	const mergedFiles: Record<string, Uint8Array> = {};
	for (const path of [...paths].sort()) {
		const baseFile = base.files[path];
		const localFile = local.files[path];
		const upstreamFile = upstream.files[path];
		const baseDigest = baseFile ? digestFile(baseFile) : null;
		const localDigest = localFile ? digestFile(localFile) : null;
		const upstreamDigest = upstreamFile ? digestFile(upstreamFile) : null;
		const changedLocal = !equalBytes(localFile, baseFile);
		const changedUpstream = !equalBytes(upstreamFile, baseFile);
		const secret = path === SECRETS_FILE || isSensitivePath(path);
		let status: PackageChange["status"] = "unchanged";
		if (secret && changedUpstream) {
			status = "conflict";
		} else if (!(changedLocal || changedUpstream)) {
			status = "unchanged";
		} else if (!changedLocal) {
			status = upstreamFile ? (baseFile ? "modified" : "added") : "removed";
		} else if (!changedUpstream || equalBytes(localFile, upstreamFile)) {
			status = localFile ? (baseFile ? "modified" : "added") : "removed";
		} else {
			status = "conflict";
		}
		changes.push({
			baseDigest,
			localDigest,
			path,
			secret,
			status,
			upstreamDigest,
		});
		const merged = mergeFile(
			path,
			baseFile,
			localFile,
			upstreamFile,
			conflicts
		);
		if (merged) {
			mergedFiles[path] = merged;
		}
	}
	const manifestConflicts: string[] = [];
	const mergedManifestValue = mergeJsonValue(
		base.manifest,
		local.manifest,
		upstream.manifest,
		PACKAGE_MANIFEST_FILE,
		manifestConflicts
	);
	conflicts.push(...manifestConflicts);
	const mergedManifest =
		conflicts.length === 0
			? validatePackageManifest(mergedManifestValue)
			: local.manifest;
	return {
		changes,
		conflicts: [...new Set(conflicts)].sort(),
		merged:
			conflicts.length === 0
				? { files: mergedFiles, manifest: mergedManifest }
				: null,
	};
}

function assertInside(root: string, path: string): void {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	if (
		resolvedPath !== resolvedRoot &&
		!resolvedPath.startsWith(`${resolvedRoot}${sep}`)
	) {
		throw new Error(`Package path escapes root: ${path}`);
	}
}

interface PackageReadBudget {
	fileCount: number;
	totalBytes: number;
}

async function ensureSafeDirectory(
	root: string,
	directory: string
): Promise<void> {
	const relativeDirectory = relative(root, directory);
	let current = resolve(root);
	try {
		const metadata = await lstat(current);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw new Error(`Package output root is not a directory: ${current}`);
		}
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			await mkdir(current, { recursive: true });
		} else {
			throw error;
		}
	}
	const segments = relativeDirectory
		.split(sep)
		.filter((segment) => segment.length > 0);
	for (const segment of segments) {
		current = join(current, segment);
		try {
			const metadata = await lstat(current);
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				throw new Error(`Package output path is not a directory: ${current}`);
			}
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") {
				await mkdir(current);
				continue;
			}
			throw error;
		}
	}
}

async function assertSafeOutputFile(path: string): Promise<void> {
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) {
			throw new Error(`Package output cannot be a symbolic link: ${path}`);
		}
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
}

async function collectFiles(
	root: string,
	directory: string,
	files: Record<string, Uint8Array>,
	budget: PackageReadBudget
): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const absolute = join(directory, entry.name);
		assertInside(root, absolute);
		if (entry.isSymbolicLink()) {
			throw new Error(
				`Package folders cannot contain symbolic links: ${entry.name}`
			);
		}
		if (entry.isDirectory()) {
			await collectFiles(root, absolute, files, budget);
			continue;
		}
		if (!entry.isFile()) {
			throw new Error(`Unsupported package entry: ${entry.name}`);
		}
		const path = normalizePath(relative(root, absolute));
		if (path === PACKAGE_MANIFEST_FILE) {
			continue;
		}
		const metadata = await stat(absolute);
		if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
			throw new Error(`Package file size is invalid: ${path}`);
		}
		if (metadata.size > MAX_PACKAGE_FILE_BYTES) {
			throw new Error(`Package file exceeds the 32 MiB limit: ${path}`);
		}
		budget.fileCount += 1;
		if (budget.fileCount > MAX_PACKAGE_FILES) {
			throw new Error("Package folder contains too many files");
		}
		budget.totalBytes += metadata.size;
		if (budget.totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
			throw new Error("Package folder exceeds the 64 MiB file limit");
		}
		files[path] = new Uint8Array(await readFile(absolute));
	}
}

export async function readPackageFolder(root: string): Promise<PackageTree> {
	const absoluteRoot = resolve(root);
	const rootMetadata = await lstat(absoluteRoot);
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
		throw new Error(`Package folder root is not a directory: ${absoluteRoot}`);
	}
	const manifestPath = join(absoluteRoot, PACKAGE_MANIFEST_FILE);
	const manifestMetadata = await lstat(manifestPath);
	if (
		manifestMetadata.isSymbolicLink() ||
		!manifestMetadata.isFile() ||
		!Number.isSafeInteger(manifestMetadata.size) ||
		manifestMetadata.size < 0 ||
		manifestMetadata.size > MAX_PACKAGE_FILE_BYTES
	) {
		throw new Error(
			`${PACKAGE_MANIFEST_FILE} exceeds the 32 MiB package file limit`
		);
	}
	const manifest = validatePackageManifest(
		JSON.parse(await readFile(manifestPath, "utf8")) as unknown
	);
	const files: Record<string, Uint8Array> = {};
	await collectFiles(absoluteRoot, absoluteRoot, files, {
		fileCount: 0,
		totalBytes: manifestMetadata.size,
	});
	return validatePackageTree({ files, manifest });
}

export async function writePackageFolder(
	root: string,
	tree: PackageTree
): Promise<void> {
	validatePackageTree(tree);
	const absoluteRoot = resolve(root);
	await ensureSafeDirectory(absoluteRoot, absoluteRoot);
	await assertSafeOutputFile(join(absoluteRoot, PACKAGE_MANIFEST_FILE));
	await writeFile(
		join(absoluteRoot, PACKAGE_MANIFEST_FILE),
		`${canonicalJson(tree.manifest)}\n`,
		"utf8"
	);
	for (const [rawPath, data] of Object.entries(tree.files)) {
		const path = normalizePath(rawPath);
		const absolute = join(absoluteRoot, ...path.split("/"));
		assertInside(absoluteRoot, absolute);
		await ensureSafeDirectory(absoluteRoot, dirname(absolute));
		await assertSafeOutputFile(absolute);
		await writeFile(absolute, data);
	}
}

function archiveEntries(tree: PackageTree): Zippable {
	const entries: Zippable = {
		[PACKAGE_MANIFEST_FILE]: [
			manifestBytes(tree.manifest),
			{ mtime: ZIP_EPOCH },
		],
	};
	for (const path of Object.keys(tree.files).sort()) {
		const data = tree.files[path];
		if (data) {
			entries[normalizePath(path)] = [data, { mtime: ZIP_EPOCH }];
		}
	}
	return entries;
}

export function packPackage(tree: PackageTree): Uint8Array {
	validatePackageTree(tree);
	return zipSync(archiveEntries(tree), { level: 6, mtime: 0 });
}

export function unpackPackage(data: Uint8Array): PackageTree {
	if (data.byteLength > MAX_PACKAGE_ARCHIVE_BYTES) {
		throw new PackageValidationError([
			{
				path: "archive",
				message: "archive exceeds the 64 MiB compressed limit",
			},
		]);
	}
	let fileCount = 0;
	let totalBytes = 0;
	const entries = unzipSync(data, {
		filter: (entry) => {
			fileCount += 1;
			const originalSize = entry.originalSize ?? entry.size ?? 0;
			if (fileCount > MAX_PACKAGE_FILES) {
				throw new PackageValidationError([
					{ path: "files", message: "archive contains too many files" },
				]);
			}
			if (originalSize > MAX_PACKAGE_FILE_BYTES) {
				throw new PackageValidationError([
					{
						path: entry.name,
						message: "archive entry exceeds the 32 MiB file limit",
					},
				]);
			}
			totalBytes += originalSize;
			if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
				throw new PackageValidationError([
					{
						path: "files",
						message: "archive exceeds the 64 MiB unpacked limit",
					},
				]);
			}
			return true;
		},
	});
	const manifestData = entries[PACKAGE_MANIFEST_FILE];
	if (!manifestData) {
		throw new PackageValidationError([
			{
				path: PACKAGE_MANIFEST_FILE,
				message: "archive is missing the package manifest",
			},
		]);
	}
	const manifest = validatePackageManifest(
		JSON.parse(stringFromBytes(manifestData)) as unknown
	);
	const files: Record<string, Uint8Array> = {};
	for (const [rawPath, value] of Object.entries(entries)) {
		if (rawPath === PACKAGE_MANIFEST_FILE) {
			continue;
		}
		const path = normalizePath(rawPath);
		files[path] = value;
	}
	return validatePackageTree({ files, manifest });
}

function githubHeaders(): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "ryu-portable-packages",
	};
}

function githubRepositoryParts(repository: string): [string, string] | null {
	const parts = repository.split("/").filter(Boolean);
	if (
		parts.length !== 2 ||
		parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
	) {
		return null;
	}
	const owner = parts[0];
	const name = parts[1];
	if (!(owner && name)) {
		return null;
	}
	return [owner, name.replace(/\.git$/i, "")];
}

function githubRawPackageUrl(
	repository: string,
	commitSha: string,
	packagePath: string,
	relativePath: string
): string {
	const packageFilePath = [packagePath, relativePath]
		.filter(Boolean)
		.join("/")
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(commitSha)}/${packageFilePath}`;
}

export function parseGithubPackageReference(
	input: string
): GithubPackageReference | null {
	const value = input.trim();
	if (!value) {
		return null;
	}
	let repository = "";
	let path = "";
	let ref = "main";
	if (/^https?:\/\/github\.com\//i.test(value)) {
		const url = new URL(value);
		const parts = url.pathname
			.split("/")
			.filter(Boolean)
			.map(decodeURIComponent);
		if (parts.length < 2) {
			return null;
		}
		repository = `${parts[0]}/${parts[1]}`;
		if (parts[2] === "tree" || parts[2] === "blob") {
			if (!parts[3]) {
				return null;
			}
			ref = parts[3];
			path = parts.slice(4).join("/");
		} else {
			path = parts.slice(2).join("/");
		}
	} else {
		const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/(.*))?$/.exec(value);
		if (!match) {
			return null;
		}
		const repositoryPart = match[1];
		if (!repositoryPart) {
			return null;
		}
		repository = repositoryPart;
		path = match[2] ?? "";
		const at = path.lastIndexOf("@");
		if (at > 0) {
			ref = path.slice(at + 1) || "main";
			path = path.slice(0, at);
		}
	}
	const parts = githubRepositoryParts(repository);
	if (!parts) {
		return null;
	}
	if (path.endsWith(`/${PACKAGE_MANIFEST_FILE}`)) {
		path = path.slice(0, -PACKAGE_MANIFEST_FILE.length - 1);
	}
	if (path) {
		try {
			normalizePath(path);
		} catch {
			return null;
		}
	}
	return { path, ref, repository: `${parts[0]}/${parts[1]}` };
}

async function githubJson(
	fetcher: PackageFetcher,
	url: string
): Promise<Record<string, unknown>> {
	const response = await fetcher(url, { headers: githubHeaders() });
	if (!response.ok) {
		throw new Error(`GitHub package request failed (${response.status})`);
	}
	const value: unknown = JSON.parse(
		new TextDecoder().decode(
			await readBoundedResponseBytes(
				response,
				MAX_GITHUB_JSON_BYTES,
				"GitHub metadata response exceeds the 4 MiB limit"
			)
		)
	);
	if (!isRecord(value)) {
		throw new Error("GitHub package response was not an object");
	}
	return value;
}

interface GithubPackageTreeEntry {
	path: string;
	size?: number;
	type: "blob";
}

function githubTreeEntries(
	value: Record<string, unknown>
): Record<string, unknown>[] {
	if (value.truncated === true) {
		throw new Error(
			"GitHub package tree was truncated; select a package subdirectory or reduce the repository size"
		);
	}
	return Array.isArray(value.tree) ? value.tree.filter(isRecord) : [];
}

async function githubPackageTreeEntries(
	fetcher: PackageFetcher,
	apiBase: string,
	rootSha: string,
	packagePath: string
): Promise<GithubPackageTreeEntry[]> {
	let requests = 0;
	const trees = new Map<string, Record<string, unknown>[]>();
	const fetchTree = async (sha: string): Promise<Record<string, unknown>[]> => {
		const cached = trees.get(sha);
		if (cached) {
			return cached;
		}
		requests += 1;
		if (requests > MAX_GITHUB_TREE_REQUESTS) {
			throw new Error("GitHub package contains too many directories");
		}
		const tree = githubTreeEntries(
			await githubJson(
				fetcher,
				`${apiBase}/git/trees/${encodeURIComponent(sha)}`
			)
		);
		trees.set(sha, tree);
		return tree;
	};

	const rootEntries = await fetchTree(rootSha);
	const prefix = packagePath ? `${packagePath}/` : "";
	const legacyEntries = rootEntries.filter(
		(entry) =>
			typeof entry.path === "string" &&
			entry.path.startsWith(prefix) &&
			entry.type === "blob"
	);
	// Older GitHub mocks and a few enterprise proxies return a flat recursive
	// listing even when `recursive=1` is omitted. Accept that shape only when the
	// selected package is unambiguous; never accept a truncated listing.
	if (
		packagePath &&
		legacyEntries.some(
			(entry) => entry.path === `${prefix}${PACKAGE_MANIFEST_FILE}`
		)
	) {
		if (legacyEntries.length > MAX_PACKAGE_FILES) {
			throw new Error("GitHub package contains too many files");
		}
		let totalBytes = 0;
		return legacyEntries.map((entry) => {
			const path = normalizePath(String(entry.path).slice(prefix.length));
			const size = typeof entry.size === "number" ? entry.size : 0;
			if (size > MAX_PACKAGE_FILE_BYTES) {
				throw new Error(
					`GitHub package file exceeds the 32 MiB limit: ${path}`
				);
			}
			totalBytes += size;
			if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
				throw new Error(
					"GitHub package exceeds the 64 MiB declared size limit"
				);
			}
			return {
				path,
				type: "blob" as const,
				size: typeof entry.size === "number" ? entry.size : undefined,
			};
		});
	}

	let fileCount = 0;
	let totalBytes = 0;
	const result: GithubPackageTreeEntry[] = [];
	const addBlob = (
		entry: Record<string, unknown>,
		relativePath: string
	): void => {
		const path = normalizePath(relativePath);
		fileCount += 1;
		if (fileCount > MAX_PACKAGE_FILES) {
			throw new Error("GitHub package contains too many files");
		}
		const size = typeof entry.size === "number" ? entry.size : 0;
		if (size > MAX_PACKAGE_FILE_BYTES) {
			throw new Error(`GitHub package file exceeds the 32 MiB limit: ${path}`);
		}
		totalBytes += size;
		if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
			throw new Error("GitHub package exceeds the 64 MiB declared size limit");
		}
		result.push({
			path,
			type: "blob",
			size: typeof entry.size === "number" ? entry.size : undefined,
		});
	};

	const walk = async (sha: string, relativePrefix: string): Promise<void> => {
		for (const entry of await fetchTree(sha)) {
			const entryPath = typeof entry.path === "string" ? entry.path : "";
			if (!entryPath || entry.type === "commit") {
				continue;
			}
			const relativePath = relativePrefix
				? `${relativePrefix}/${entryPath}`
				: entryPath;
			if (entry.type === "blob") {
				addBlob(entry, relativePath);
				continue;
			}
			if (entry.type === "tree" && typeof entry.sha === "string") {
				await walk(entry.sha, relativePath);
			}
		}
	};

	let selectedSha = rootSha;
	if (packagePath) {
		for (const segment of packagePath.split("/")) {
			const entry = (await fetchTree(selectedSha)).find(
				(candidate) => candidate.path === segment && candidate.type === "tree"
			);
			if (!entry || typeof entry.sha !== "string") {
				throw new Error(`GitHub package path was not found: ${packagePath}`);
			}
			selectedSha = entry.sha;
		}
	}
	await walk(selectedSha, "");
	return result;
}

export async function readGithubPackage(
	input: string,
	fetcher: PackageFetcher = fetch as unknown as PackageFetcher
): Promise<ResolvedGithubPackage> {
	const reference = parseGithubPackageReference(input);
	if (!reference) {
		throw new Error(
			"Expected a GitHub package folder URL or owner/repo/path reference"
		);
	}
	const [owner, repositoryName] = reference.repository.split("/");
	const apiBase = `https://api.github.com/repos/${owner}/${repositoryName}`;
	const commit = await githubJson(
		fetcher,
		`${apiBase}/commits/${encodeURIComponent(reference.ref)}`
	);
	const commitSha = typeof commit.sha === "string" ? commit.sha : "";
	if (!commitSha) {
		throw new Error("GitHub package response did not contain a commit SHA");
	}
	const commitTree =
		isRecord(commit.tree) && typeof commit.tree.sha === "string"
			? commit.tree.sha
			: commitSha;
	const treeEntries = await githubPackageTreeEntries(
		fetcher,
		apiBase,
		commitTree,
		reference.path
	);
	const manifestEntry = treeEntries.find(
		(entry) => entry.path === PACKAGE_MANIFEST_FILE
	);
	if (!manifestEntry) {
		throw new Error(`GitHub package path is missing ${PACKAGE_MANIFEST_FILE}`);
	}
	const files: Record<string, Uint8Array> = {};
	let downloadedBytes = 0;
	for (const blob of treeEntries) {
		if (blob.path === PACKAGE_MANIFEST_FILE) {
			continue;
		}
		const response = await fetcher(
			githubRawPackageUrl(
				reference.repository,
				commitSha,
				reference.path,
				blob.path
			),
			{ headers: githubHeaders() }
		);
		if (!response.ok) {
			throw new Error(
				`GitHub package file request failed (${response.status})`
			);
		}
		const relativePath = blob.path;
		const data = await readBoundedResponseBytes(
			response,
			MAX_PACKAGE_FILE_BYTES,
			`GitHub package file exceeds the 32 MiB limit: ${relativePath}`
		);
		downloadedBytes += data.byteLength;
		if (downloadedBytes > MAX_PACKAGE_TOTAL_BYTES) {
			throw new Error("GitHub package exceeds the 64 MiB download limit");
		}
		files[normalizePath(relativePath)] = data;
	}
	const manifestResponse = await fetcher(
		githubRawPackageUrl(
			reference.repository,
			commitSha,
			reference.path,
			manifestEntry.path
		),
		{ headers: githubHeaders() }
	);
	if (!manifestResponse.ok) {
		throw new Error(
			`GitHub package manifest request failed (${manifestResponse.status})`
		);
	}
	const manifestBytes = await readBoundedResponseBytes(
		manifestResponse,
		MAX_PACKAGE_FILE_BYTES,
		"GitHub package manifest exceeds the 32 MiB limit"
	);
	if (downloadedBytes + manifestBytes.byteLength > MAX_PACKAGE_TOTAL_BYTES) {
		throw new Error("GitHub package exceeds the 64 MiB download limit");
	}
	const manifest = validatePackageManifest(
		JSON.parse(stringFromBytes(manifestBytes)) as unknown
	);
	const resolvedTree = validatePackageTree({ files, manifest });
	return {
		commit: commitSha,
		source: {
			commit: commitSha,
			path: reference.path,
			ref: reference.ref,
			repository: reference.repository,
			type: "github",
		},
		tree: resolvedTree,
	};
}

export async function readPackageInput(input: string): Promise<PackageTree> {
	try {
		const metadata = await stat(input);
		if (metadata.isDirectory()) {
			return readPackageFolder(input);
		}
		if (metadata.isFile()) {
			if (
				!Number.isSafeInteger(metadata.size) ||
				metadata.size > MAX_PACKAGE_ARCHIVE_BYTES
			) {
				throw new Error("package archive exceeds the 64 MiB compressed limit");
			}
			return unpackPackage(new Uint8Array(await readFile(input)));
		}
	} catch (error) {
		const code = isRecord(error) ? error.code : null;
		switch (code) {
			case "ENOENT":
			case "ENOTDIR":
				break;
			default:
				throw error;
		}
	}
	if (parseGithubPackageReference(input)) {
		return (await readGithubPackage(input)).tree;
	}
	throw new Error(`Package path does not exist: ${input}`);
}

export async function writePackageArchive(
	path: string,
	tree: PackageTree
): Promise<void> {
	const absolutePath = resolve(path);
	const parent = dirname(absolutePath);
	await ensureSafeDirectory(parent, parent);
	await assertSafeOutputFile(absolutePath);
	await writeFile(absolutePath, packPackage(tree));
}

export async function packagePathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function packageFileText(
	tree: PackageTree,
	path: string
): string | null {
	const data = tree.files[normalizePath(path)];
	return data ? stringFromBytes(data) : null;
}

export function packageFileJson(
	tree: PackageTree,
	path: string
): unknown | null {
	const text = packageFileText(tree, path);
	if (text === null) {
		return null;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

export function packageArtifactPaths(tree: PackageTree): string[] {
	return Object.keys(tree.files)
		.filter((path) => path !== SECRETS_FILE)
		.sort();
}

export function validatePackageTree(tree: PackageTree): PackageTree {
	const manifest = validatePackageManifest(tree.manifest);
	const issues: PackageValidationIssue[] = [];
	const paths = Object.keys(tree.files);
	if (paths.length > MAX_PACKAGE_FILES) {
		issues.push({
			path: "files",
			message: `contains more than ${MAX_PACKAGE_FILES} files`,
		});
	}
	let totalBytes = manifestBytes(manifest).byteLength;
	for (const artifact of manifest.artifacts) {
		if (!(artifact in tree.files)) {
			issues.push({
				path: artifact,
				message: "declared artifact is missing from the package",
			});
		}
	}
	for (const path of paths) {
		try {
			normalizePath(path);
		} catch {
			issues.push({ path, message: "contains an unsafe file path" });
			continue;
		}
		const data = tree.files[path];
		if (!(data instanceof Uint8Array)) {
			issues.push({ path, message: "must contain bytes" });
			continue;
		}
		if (data.byteLength > MAX_PACKAGE_FILE_BYTES) {
			issues.push({ path, message: "exceeds the 32 MiB file limit" });
		}
		totalBytes += data.byteLength;
		if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
			issues.push({
				path: "files",
				message: "exceeds the 64 MiB total file limit",
			});
			break;
		}
	}
	if (issues.length > 0) {
		throw new PackageValidationError(issues);
	}
	return { files: tree.files, manifest };
}

export function packageIsPublishable(tree: PackageTree): boolean {
	return !(
		hasEncryptedSecrets(tree) ||
		tree.manifest.security.containsSecrets ||
		tree.manifest.security.privateContent
	);
}

export function validatePublishablePackage(tree: PackageTree): void {
	validatePackageTree(tree);
	if (hasEncryptedSecrets(tree) || tree.manifest.security.containsSecrets) {
		throw new PackageValidationError([
			{
				path: SECRETS_FILE,
				message: "secret-bearing packages cannot be published to a marketplace",
			},
		]);
	}
	if (tree.manifest.security.privateContent) {
		throw new PackageValidationError([
			{
				path: "security.privateContent",
				message:
					"private-content packages cannot be published to a marketplace",
			},
		]);
	}
	for (const path of Object.keys(tree.files)) {
		if (isSensitivePath(path)) {
			throw new PackageValidationError([
				{ path, message: "sensitive files must be removed before publishing" },
			]);
		}
	}
}

export function packageSummary(tree: PackageTree) {
	return {
		artifacts: [...tree.manifest.artifacts],
		checksum: packageDigest(tree),
		files: packageArtifactPaths(tree),
		id: tree.manifest.id,
		kind: tree.manifest.kind,
		name: tree.manifest.name,
		security: tree.manifest.security,
		version: tree.manifest.version,
	};
}
