/**
 * Public entry for `@ryu/portable-packages`. The implementation is split by
 * responsibility into the `package-*.ts` modules; this file only re-exports the
 * public surface so import paths stay stable.
 */

export * from "./connection-requirements.ts";
export { nativeJsonSchema } from "./native-json.ts";
export { diffPackageTrees } from "./package-diff.ts";
export {
	parseGithubPackageReference,
	readGithubPackage,
} from "./package-github.ts";
export {
	packagePathExists,
	packPackage,
	readPackageFolder,
	readPackageInput,
	unpackPackage,
	writePackageArchive,
	writePackageFolder,
} from "./package-io.ts";
export {
	canonicalJson,
	packageAllowsRemix,
	packageDigest,
	validatePackageManifest,
} from "./package-manifest.ts";
export {
	decryptSecrets,
	encryptSecrets,
	hasEncryptedSecrets,
	withEncryptedSecrets,
} from "./package-secrets.ts";
export {
	languagePackFromTree,
	languagePackPackageTree,
	packageArtifactPaths,
	packageFileJson,
	packageFileText,
	packageIsPublishable,
	packageSummary,
	redactPackageTree,
	validatePackageTree,
	validatePublishablePackage,
} from "./package-tree.ts";
export {
	type GithubPackageReference,
	PACKAGE_ARCHIVE_EXTENSION,
	PACKAGE_KINDS,
	PACKAGE_MANIFEST_FILE,
	PACKAGE_SCHEMA_VERSION,
	PACKAGE_SCOPES,
	type PackageChange,
	type PackageKind,
	type PackageRemixSource,
	type PackageScope,
	type PackageSecurity,
	type PackageSource,
	type PackageTree,
	type PackageUpdateDiff,
	PackageValidationError,
	type PackageValidationIssue,
	type ResolvedGithubPackage,
	type RyuPackageManifest,
	SECRETS_FILE,
	type SecretEnvelope,
} from "./package-types.ts";
