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
import { wireObject } from "@ryuhq/protocol/wire-object";
import { unzipSync, type Zippable, zipSync } from "fflate";
import { z } from "zod";
import {
	parseGithubPackageReference,
	readGithubPackage,
} from "./package-github.ts";
import {
	canonicalJson,
	manifestBytes,
	normalizePath,
	stringFromBytes,
	validatePackageManifest,
} from "./package-manifest.ts";
import { validatePackageTree } from "./package-tree.ts";
import {
	MAX_PACKAGE_ARCHIVE_BYTES,
	MAX_PACKAGE_FILE_BYTES,
	MAX_PACKAGE_FILES,
	MAX_PACKAGE_TOTAL_BYTES,
	PACKAGE_MANIFEST_FILE,
	type PackageTree,
	PackageValidationError,
} from "./package-types.ts";

const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");

const errorCodeSchema = wireObject({
	code: z.string().or(z.undefined()).catch(undefined),
});
function errorCode(
	error: Parameters<typeof errorCodeSchema.parse>[0]
): string | undefined {
	const decoded = errorCodeSchema.safeParse(error);
	return decoded.success ? decoded.data.code : undefined;
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
		if (errorCode(error) === "ENOENT") {
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
			if (errorCode(error) === "ENOENT") {
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
		if (errorCode(error) === "ENOENT") {
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
		JSON.parse(await readFile(manifestPath, "utf8"))
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
		JSON.parse(stringFromBytes(manifestData))
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
		const code = errorCode(error);
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
