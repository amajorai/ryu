import { z } from "zod";
import {
	type GithubTreeEntry,
	githubCommitResponseSchema,
	githubTreeResponseSchema,
} from "./github-response.ts";
import {
	normalizePath,
	stringFromBytes,
	validatePackageManifest,
} from "./package-manifest.ts";
import { validatePackageTree } from "./package-tree.ts";
import {
	type GithubPackageReference,
	MAX_GITHUB_JSON_BYTES,
	MAX_GITHUB_TREE_REQUESTS,
	MAX_PACKAGE_FILE_BYTES,
	MAX_PACKAGE_FILES,
	MAX_PACKAGE_TOTAL_BYTES,
	PACKAGE_MANIFEST_FILE,
	type PackageFetcher,
	type ResolvedGithubPackage,
} from "./package-types.ts";

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

function githubHeaders() {
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

async function githubJson<T>(
	fetcher: PackageFetcher,
	url: string,
	schema: z.ZodType<T>
): Promise<T> {
	const response = await fetcher(url, { headers: githubHeaders() });
	if (!response.ok) {
		throw new Error(`GitHub package request failed (${response.status})`);
	}
	const value = JSON.parse(
		new TextDecoder().decode(
			await readBoundedResponseBytes(
				response,
				MAX_GITHUB_JSON_BYTES,
				"GitHub metadata response exceeds the 4 MiB limit"
			)
		)
	);
	if (!z.looseObject({}).safeParse(value).success) {
		throw new Error("GitHub package response was not an object");
	}
	return schema.parse(value);
}

interface GithubPackageTreeEntry {
	path: string;
	size?: number;
	type: "blob";
}

function githubTreeEntries(
	value: z.infer<typeof githubTreeResponseSchema>
): GithubTreeEntry[] {
	if (value.truncated === true) {
		throw new Error(
			"GitHub package tree was truncated; select a package subdirectory or reduce the repository size"
		);
	}
	return value.tree;
}

async function githubPackageTreeEntries(
	fetcher: PackageFetcher,
	apiBase: string,
	rootSha: string,
	packagePath: string
): Promise<GithubPackageTreeEntry[]> {
	let requests = 0;
	const trees = new Map<string, GithubTreeEntry[]>();
	const fetchTree = async (sha: string): Promise<GithubTreeEntry[]> => {
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
				`${apiBase}/git/trees/${encodeURIComponent(sha)}`,
				githubTreeResponseSchema
			)
		);
		trees.set(sha, tree);
		return tree;
	};

	const rootEntries = await fetchTree(rootSha);
	const prefix = packagePath ? `${packagePath}/` : "";
	const legacyEntries = rootEntries.filter(
		(entry) => entry.path?.startsWith(prefix) && entry.type === "blob"
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
			const size = entry.size ?? 0;
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
				size: entry.size,
			};
		});
	}

	let fileCount = 0;
	let totalBytes = 0;
	const result: GithubPackageTreeEntry[] = [];
	const addBlob = (entry: GithubTreeEntry, relativePath: string): void => {
		const path = normalizePath(relativePath);
		fileCount += 1;
		if (fileCount > MAX_PACKAGE_FILES) {
			throw new Error("GitHub package contains too many files");
		}
		const size = entry.size ?? 0;
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
			size: entry.size,
		});
	};

	const walk = async (sha: string, relativePrefix: string): Promise<void> => {
		for (const entry of await fetchTree(sha)) {
			const entryPath = entry.path ?? "";
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
			if (entry.type === "tree" && entry.sha !== undefined) {
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
			if (!entry || entry.sha === undefined) {
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
	fetcher: PackageFetcher = fetch
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
		`${apiBase}/commits/${encodeURIComponent(reference.ref)}`,
		githubCommitResponseSchema
	);
	const commitSha = commit.sha ?? "";
	if (!commitSha) {
		throw new Error("GitHub package response did not contain a commit SHA");
	}
	const commitTree = commit.tree?.sha ?? commitSha;
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
		JSON.parse(stringFromBytes(manifestBytes))
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
