import { createHash } from "node:crypto";
import type { LanguagePack } from "@ryu/i18n/core";
import { LANGUAGE_PACK_ARTIFACT } from "@ryu/i18n/core";
import {
	CONNECTION_REQUIREMENT_FIELDS,
	type ConnectionRequirement,
	ConnectionRequirementValidationError,
	normalizePackageConnectionRequirements,
} from "./connection-requirements.ts";
import { manifestFieldsSchema, packageScopeSchema } from "./manifest-fields.ts";
import { isPortablePackagePath } from "./package-path.ts";
import {
	PACKAGE_KINDS,
	PACKAGE_MANIFEST_FILE,
	PACKAGE_SCHEMA_VERSION,
	type PackageTree,
	PackageValidationError,
	type PackageValidationIssue,
	type RyuPackageManifest,
	SECRETS_FILE,
} from "./package-types.ts";
import {
	type PackageSerdeValue,
	packageSerdeObjectSchema,
	packageSerdeSchema,
} from "./serde.ts";

const SENSITIVE_FILE_RE =
	/(^|\/)(?:\.env(?:\..*)?|secrets?\.(?:json|ya?ml)|credentials?\.(?:json|ya?ml)|.*\.(?:pem|key|p12|pfx))$/i;
const PRIVATE_CONTENT_RE = /^(?:content|documents|private)(?:\/|$)/i;

function cleanStringArray(value: string[] | undefined): string[] {
	return value?.map((item) => item.trim()).filter(Boolean) ?? [];
}

export function normalizePath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!isPortablePackagePath(normalized)) {
		throw new PackageValidationError([
			{ path: "files", message: `unsafe package path: ${path}` },
		]);
	}
	return normalized;
}

function stringField(
	value: string | undefined,
	path: string,
	issues: PackageValidationIssue[]
): string {
	if (value === undefined || value.trim() === "") {
		issues.push({ path, message: "must be a non-empty string" });
		return "";
	}
	return value.trim();
}

export function validatePackageManifest(
	input: Parameters<typeof manifestFieldsSchema.parse>[0]
): RyuPackageManifest {
	const issues: PackageValidationIssue[] = [];
	const decoded = manifestFieldsSchema.safeParse(input);
	if (!decoded.success) {
		throw new PackageValidationError([
			{ path: PACKAGE_MANIFEST_FILE, message: "must contain a JSON object" },
		]);
	}
	const value = decoded.data;
	const schemaVersion = value.schemaVersion;
	if (schemaVersion !== PACKAGE_SCHEMA_VERSION) {
		issues.push({
			path: "schemaVersion",
			message: `must be ${PACKAGE_SCHEMA_VERSION}`,
		});
	}
	const kind = value.kind;
	if (kind === undefined) {
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
	const scopes = cleanStringArray(value.scopes).flatMap((scope) => {
		const parsed = packageScopeSchema.safeParse(scope);
		return parsed.success ? [parsed.data] : [];
	});
	const requirements = value.requires;
	const capabilities = cleanStringArray(value.capabilities);
	const hasConnectionRequirements = CONNECTION_REQUIREMENT_FIELDS.some(
		(field) => Object.hasOwn(new Object(input), field)
	);
	let connectionRequirements: ConnectionRequirement[] | undefined;
	if (hasConnectionRequirements) {
		try {
			connectionRequirements = normalizePackageConnectionRequirements(input);
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
	if (value.artifacts === undefined) {
		issues.push({ path: "artifacts", message: "must be an array of strings" });
	}
	if (value.targets === undefined) {
		issues.push({ path: "targets", message: "must be an array of strings" });
	}
	if (value.scopes === undefined) {
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
	if (issues.length > 0 || kind === undefined) {
		throw new PackageValidationError(issues);
	}
	const manifest: RyuPackageManifest = {
		$schema: value.$schema,
		artifacts,
		capabilities,
		id,
		includes: cleanStringArray(value.includes),
		kind,
		name,
		requires: requirements,
		schemaVersion: PACKAGE_SCHEMA_VERSION,
		security: value.security,
		source: value.source,
		targets,
		version,
		scopes,
		metadata: value.metadata,
	};
	const allowRemix = value.allowRemix ?? value.allow_remix;
	if (allowRemix !== undefined) {
		manifest.allowRemix = allowRemix;
	}
	if (value.remixedFrom) {
		manifest.remixedFrom = value.remixedFrom;
	}
	if (hasConnectionRequirements) {
		manifest.connectionRequirements = connectionRequirements ?? [];
	}
	return manifest;
}

/** Whether a package may be remixed. Absent means allowed (the default). */
export function packageAllowsRemix(
	manifest: Pick<RyuPackageManifest, "allowRemix">
): boolean {
	return manifest.allowRemix !== false;
}

function canonicalize(value: PackageSerdeValue): PackageSerdeValue {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	const object = packageSerdeObjectSchema.safeParse(value);
	if (!object.success) {
		return value;
	}
	return Object.fromEntries(
		Object.keys(object.data)
			.sort()
			.map((key) => [key, canonicalize(object.data[key])])
	);
}

export function canonicalJson(
	value: Parameters<typeof packageSerdeSchema.parse>[0]
): string | undefined {
	return JSON.stringify(canonicalize(packageSerdeSchema.parse(value)));
}

export function manifestBytes(manifest: RyuPackageManifest): Uint8Array {
	return new TextEncoder().encode(`${canonicalJson(manifest)}\n`);
}

function digestBytes(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function digestFile(data: Uint8Array): string {
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

export function isSensitivePath(path: string): boolean {
	return path === SECRETS_FILE || SENSITIVE_FILE_RE.test(path);
}

export function isPrivateContentPath(path: string): boolean {
	return PRIVATE_CONTENT_RE.test(path);
}

export function bytesFromString(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

export function stringFromBytes(value: Uint8Array): string {
	return new TextDecoder().decode(value);
}

export function languagePackIdentityIssues(
	pack: LanguagePack,
	manifest: RyuPackageManifest
): PackageValidationIssue[] {
	const issues: PackageValidationIssue[] = [];
	if (pack.id !== manifest.id) {
		issues.push({
			path: LANGUAGE_PACK_ARTIFACT,
			message: "language-pack id must match the package manifest",
		});
	}
	const normalizeVersion = (value: string) => value.trim().replace(/^v/iu, "");
	if (normalizeVersion(pack.version) !== normalizeVersion(manifest.version)) {
		issues.push({
			path: LANGUAGE_PACK_ARTIFACT,
			message: "language-pack version must match the package manifest",
		});
	}
	return issues;
}
