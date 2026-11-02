import {
	LANGUAGE_PACK_ARTIFACT,
	type LanguagePack,
	languagePackJson,
	languagePackPortableManifest,
	parseLanguagePackJson,
	validateLanguagePack,
} from "@ryu/i18n/core";
import type { z } from "zod";
import { nativeJsonSchema } from "./native-json.ts";
import {
	isPrivateContentPath,
	isSensitivePath,
	languagePackIdentityIssues,
	manifestBytes,
	normalizePath,
	packageAllowsRemix,
	packageDigest,
	stringFromBytes,
	validatePackageManifest,
} from "./package-manifest.ts";
import { hasEncryptedSecrets } from "./package-secrets.ts";
import {
	MAX_PACKAGE_FILE_BYTES,
	MAX_PACKAGE_FILES,
	MAX_PACKAGE_TOTAL_BYTES,
	type PackageTree,
	PackageValidationError,
	type PackageValidationIssue,
	SECRETS_FILE,
} from "./package-types.ts";

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
): z.core.util.JSONType | null {
	const text = packageFileText(tree, path);
	if (text === null) {
		return null;
	}
	try {
		return nativeJsonSchema.parse(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Read and validate the language-pack artifact from a portable package tree. */
export function languagePackFromTree(tree: PackageTree): LanguagePack {
	if (tree.manifest.kind !== "language_pack") {
		throw new PackageValidationError([
			{
				path: "kind",
				message: "language-pack artifacts require kind `language_pack`",
			},
		]);
	}
	const data = tree.files[LANGUAGE_PACK_ARTIFACT];
	if (!data) {
		throw new PackageValidationError([
			{
				path: LANGUAGE_PACK_ARTIFACT,
				message: "language-pack package is missing its language-pack artifact",
			},
		]);
	}
	const pack = parseLanguagePackJson(stringFromBytes(data));
	const issues = languagePackIdentityIssues(pack, tree.manifest);
	if (issues.length > 0) {
		throw new PackageValidationError(issues);
	}
	return pack;
}

/** Build a portable package tree for a language pack without adding executable code. */
export function languagePackPackageTree(
	pack: LanguagePack,
	options: { metadata?: Record<string, z.core.util.JSONType> } = {}
): PackageTree {
	const validated = validateLanguagePack(pack);
	const manifest = validatePackageManifest(
		languagePackPortableManifest(validated, options)
	);
	return validatePackageTree({
		files: {
			[LANGUAGE_PACK_ARTIFACT]: new TextEncoder().encode(
				languagePackJson(validated)
			),
		},
		manifest,
	});
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
	if (manifest.kind === "language_pack") {
		if (paths.length !== 1 || paths[0] !== LANGUAGE_PACK_ARTIFACT) {
			issues.push({
				path: "files",
				message: "language-pack packages may contain only language-pack.json",
			});
		}
		if (
			manifest.artifacts.length !== 1 ||
			manifest.artifacts[0] !== LANGUAGE_PACK_ARTIFACT
		) {
			issues.push({
				path: "artifacts",
				message: "language-pack packages must declare only language-pack.json",
			});
		}
		if (
			manifest.capabilities.length > 0 ||
			manifest.security.containsSecrets ||
			manifest.security.privateContent ||
			manifest.security.permissions.length > 0
		) {
			issues.push({
				path: "security",
				message:
					"language-pack packages cannot declare capabilities or permissions",
			});
		}
		const artifact = tree.files[LANGUAGE_PACK_ARTIFACT];
		if (artifact) {
			try {
				const pack = parseLanguagePackJson(stringFromBytes(artifact));
				issues.push(...languagePackIdentityIssues(pack, manifest));
			} catch (error) {
				issues.push({
					path: LANGUAGE_PACK_ARTIFACT,
					message: error instanceof Error ? error.message : "is invalid",
				});
			}
		} else {
			issues.push({
				path: LANGUAGE_PACK_ARTIFACT,
				message: "language-pack package must declare a language-pack artifact",
			});
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
		allowRemix: packageAllowsRemix(tree.manifest),
		remixedFrom: tree.manifest.remixedFrom ?? null,
		security: tree.manifest.security,
		version: tree.manifest.version,
	};
}
