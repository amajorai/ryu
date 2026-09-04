import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languagePackArchive } from "@ryu/i18n/core";
import {
	canonicalJson,
	decryptSecrets,
	diffPackageTrees,
	hasEncryptedSecrets,
	languagePackFromTree,
	languagePackPackageTree,
	PACKAGE_MANIFEST_FILE,
	type PackageTree,
	packageDigest,
	packageIsPublishable,
	packPackage,
	parseGithubPackageReference,
	readGithubPackage,
	readPackageFolder,
	readPackageInput,
	redactPackageTree,
	unpackPackage,
	validatePackageManifest,
	validatePackageTree,
	validatePublishablePackage,
	withEncryptedSecrets,
	writePackageFolder,
} from "./index.ts";

const manifest = {
	artifacts: ["agent.json"],
	capabilities: ["chat"],
	id: "ryu/example-agent",
	kind: "agent",
	name: "Example Agent",
	requires: {},
	schemaVersion: 1,
	security: {
		containsSecrets: false,
		permissions: [],
		privateContent: false,
		redacted: false,
	},
	scopes: ["agent"],
	targets: ["ryu-desktop"],
	version: "1.0.0",
};

function tree(
	agentText = '{"id":"agent-1","tools":["search"]}\n'
): PackageTree {
	return {
		files: {
			"agent.json": new TextEncoder().encode(agentText),
			"README.md": new TextEncoder().encode("# Example\n"),
		},
		manifest: validatePackageManifest(manifest),
	};
}

test("validates and canonicalizes the package envelope", () => {
	const parsed = validatePackageManifest({ ...manifest, scopes: ["agent"] });
	expect(parsed.schemaVersion).toBe(1);
	expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	expect(() =>
		validatePackageManifest({ ...manifest, id: "../unsafe" })
	).toThrow("unsupported characters");
});

test("language-pack trees validate, pack, and round-trip as data-only packages", () => {
	const tree = languagePackPackageTree({
		baseLocale: "en",
		direction: "ltr",
		id: "example-online",
		locale: "en",
		messages: { "common.install": "Yeet it in" },
		name: "Example Online",
		schemaVersion: 1,
		version: "1.0.0",
	});
	expect(tree.manifest.kind).toBe("language_pack");
	expect(tree.manifest.artifacts).toEqual(["language-pack.json"]);
	expect(languagePackFromTree(tree).messages["common.install"]).toBe(
		"Yeet it in"
	);
	const roundTripped = languagePackFromTree(unpackPackage(packPackage(tree)));
	expect(roundTripped.id).toBe("example-online");
	expect(roundTripped.locale).toBe("en");
	const browserTree = unpackPackage(languagePackArchive(roundTripped));
	expect(browserTree.manifest).toMatchObject({
		artifacts: ["language-pack.json"],
		id: "example-online",
		kind: "language_pack",
	});
	expect(Object.keys(browserTree.files)).toEqual(["language-pack.json"]);
	expect(languagePackFromTree(browserTree)).toEqual(roundTripped);
	expect(() =>
		validatePackageManifest({
			...manifest,
			artifacts: ["language-pack.json"],
			kind: "language_pack",
		})
	).not.toThrow();
	expect(() =>
		validatePackageTree({
			...tree,
			files: {
				...tree.files,
				"extra.txt": new TextEncoder().encode("not allowed"),
			},
		})
	).toThrow("only language-pack.json");
	expect(() =>
		validatePackageTree({
			...tree,
			manifest: validatePackageManifest({
				...tree.manifest,
				capabilities: ["tool:execute"],
			}),
		})
	).toThrow("cannot declare capabilities");
	const mismatched = {
		...tree,
		manifest: { ...tree.manifest, id: "other-pack" },
	};
	expect(() => languagePackFromTree(mismatched)).toThrow(
		"id must match the package manifest"
	);
});

test("validates declared artifacts and preserves safe metadata", () => {
	const parsed = validatePackageManifest({
		...manifest,
		metadata: { category: "Design", tagline: "Portable" },
	});
	expect(parsed.metadata).toEqual({ category: "Design", tagline: "Portable" });
	expect(() => validatePackageTree({ files: {}, manifest: parsed })).toThrow(
		"declared artifact is missing"
	);
});

test("folder and archive representations have the same package digest", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-package-folder-"));
	try {
		await writePackageFolder(root, tree());
		const fromFolder = await readPackageFolder(root);
		const fromArchive = unpackPackage(packPackage(fromFolder));
		expect(packageDigest(fromFolder)).toBe(packageDigest(fromArchive));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("local package trees enforce archive-equivalent file limits", () => {
	const files: Record<string, Uint8Array> = { "agent.json": new Uint8Array() };
	for (let index = 0; index < 2048; index += 1) {
		files[`files/${index}.txt`] = new Uint8Array();
	}
	expect(() =>
		validatePackageTree({ files, manifest: validatePackageManifest(manifest) })
	).toThrow("2048");

	const oversized = { "agent.json": new Uint8Array(32 * 1024 * 1024 + 1) };
	expect(() =>
		validatePackageTree({
			files: oversized,
			manifest: validatePackageManifest(manifest),
		})
	).toThrow("32 MiB");
});

test("local package folders reject symlinks before reading or writing", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-package-symlink-"));
	const outside = await mkdtemp(join(tmpdir(), "ryu-package-outside-"));
	const rootLink = join(tmpdir(), `ryu-package-root-link-${Date.now()}`);
	try {
		await writeFile(
			join(root, PACKAGE_MANIFEST_FILE),
			JSON.stringify(manifest)
		);
		await writeFile(join(outside, "secret.txt"), "outside");
		await symlink(join(outside, "secret.txt"), join(root, "agent.json"));
		await expect(readPackageFolder(root)).rejects.toThrow("symbolic links");
		await symlink(root, rootLink, "dir");
		await expect(readPackageFolder(rootLink)).rejects.toThrow(
			"root is not a directory"
		);

		const writeRoot = await mkdtemp(join(tmpdir(), "ryu-package-write-"));
		try {
			await symlink(join(outside, "secret.txt"), join(writeRoot, "agent.json"));
			await expect(writePackageFolder(writeRoot, tree())).rejects.toThrow(
				"symbolic link"
			);
		} finally {
			await rm(writeRoot, { recursive: true, force: true });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
		await rm(rootLink, { recursive: true, force: true });
	}
});

test("folder trees pack and unpack deterministically", () => {
	const first = packPackage(tree());
	const second = packPackage(tree());
	expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
	const unpacked = unpackPackage(first);
	expect(packageDigest(unpacked)).toBe(packageDigest(tree()));
	expect(new TextDecoder().decode(unpacked.files["agent.json"])).toContain(
		"agent-1"
	);
});

test("encrypted secrets are detected and require the unlock key", () => {
	const encrypted = withEncryptedSecrets(
		tree(),
		{ token: "do-not-log" },
		"correct horse"
	);
	expect(hasEncryptedSecrets(encrypted)).toBe(true);
	expect(
		decryptSecrets(
			encrypted.files["secrets.enc"]!,
			"correct horse",
			encrypted.manifest
		)
	).toEqual({
		token: "do-not-log",
	});
	expect(() =>
		decryptSecrets(
			encrypted.files["secrets.enc"]!,
			"wrong key",
			encrypted.manifest
		)
	).toThrow("unlock key is incorrect");
});

test("redaction removes secret and private-content files", () => {
	const encrypted = withEncryptedSecrets(
		{
			...tree(),
			files: {
				...tree().files,
				"content/private.md": new TextEncoder().encode("private"),
				"credentials.json": new TextEncoder().encode("secret"),
			},
		},
		{ token: "secret" },
		"passphrase"
	);
	const redacted = redactPackageTree(encrypted);
	expect(redacted.files["secrets.enc"]).toBeUndefined();
	expect(redacted.files["credentials.json"]).toBeUndefined();
	expect(redacted.files["content/private.md"]).toBeUndefined();
	expect(redacted.manifest.security.containsSecrets).toBe(false);
	expect(redacted.manifest.security.privateContent).toBe(false);
	expect(packageIsPublishable(redacted)).toBe(true);

	const retainedPrivate = redactPackageTree(encrypted, {
		includePrivateContent: true,
	});
	expect(retainedPrivate.files["secrets.enc"]).toBeUndefined();
	expect(retainedPrivate.files["credentials.json"]).toBeUndefined();
	expect(retainedPrivate.files["content/private.md"]).toBeDefined();
	expect(retainedPrivate.manifest.security.containsSecrets).toBe(false);
	expect(retainedPrivate.manifest.security.privateContent).toBe(true);
	expect(packageIsPublishable(retainedPrivate)).toBe(false);
	expect(() => validatePublishablePackage(retainedPrivate)).toThrow(
		"private-content packages cannot be published"
	);
});

test("three-way JSON merge preserves local edits and accepts upstream edits", () => {
	const base = tree('{"id":"agent-1","tools":["search"],"prompt":"base"}\n');
	const local = tree(
		'{"id":"agent-1","tools":["search","calendar"],"prompt":"base"}\n'
	);
	const upstream = tree(
		'{"id":"agent-1","tools":["search"],"prompt":"upstream"}\n'
	);
	const diff = diffPackageTrees(base, local, upstream);
	expect(diff.conflicts).toEqual([]);
	expect(diff.merged).not.toBeNull();
	const merged = new TextDecoder().decode(diff.merged?.files["agent.json"]);
	expect(merged).toContain("calendar");
	expect(merged).toContain("upstream");
});

test("conflicts are explicit and secret files remain opaque", () => {
	const base = tree('{"id":"agent-1","prompt":"base"}\n');
	const local = tree('{"id":"agent-1","prompt":"local"}\n');
	const upstream = tree('{"id":"agent-1","prompt":"upstream"}\n');
	const diff = diffPackageTrees(base, local, upstream);
	expect(diff.conflicts).toContain("agent.json.prompt");
	expect(diff.merged).toBeNull();

	const secretTree = withEncryptedSecrets(
		base,
		{ token: "secret" },
		"passphrase"
	);
	const secretUpstream = withEncryptedSecrets(
		base,
		{ token: "new" },
		"passphrase"
	);
	const secretDiff = diffPackageTrees(secretTree, secretTree, secretUpstream);
	const secretChange = secretDiff.changes.find(
		(change) => change.path === "secrets.enc"
	);
	expect(secretChange?.secret).toBe(true);
});

test("publish validation rejects secret-bearing packages", () => {
	const clean = tree();
	validatePublishablePackage(clean);
	const secret = withEncryptedSecrets(clean, { token: "secret" }, "passphrase");
	expect(() => validatePublishablePackage(secret)).toThrow(
		"cannot be published"
	);
});

test("only tool and skill arrays merge as sets", () => {
	const base = tree('{"id":"agent-1","tools":["search"]}\n');
	const local = tree('{"id":"agent-1","tools":["search","calendar"]}\n');
	const upstream = tree('{"id":"agent-1","tools":["search","browser"]}\n');
	const toolDiff = diffPackageTrees(base, local, upstream);
	const merged = new TextDecoder().decode(
		toolDiff.merged?.files["agent.json"] ?? new Uint8Array()
	);

	expect(toolDiff.conflicts).not.toContain("agent.json.tools");
	expect(merged).toContain('"browser"');
	expect(merged).toContain('"calendar"');

	const labelDiff = diffPackageTrees(
		tree('{"id":"agent-1","labels":["base"]}\n'),
		tree('{"id":"agent-1","labels":["local"]}\n'),
		tree('{"id":"agent-1","labels":["upstream"]}\n')
	);
	expect(labelDiff.conflicts).toContain("agent.json.labels");

	const orderedDiff = diffPackageTrees(
		tree('{"id":"agent-1","steps":[{"id":"first"},{"id":"second"}]}\n'),
		tree('{"id":"agent-1","steps":[{"id":"second"},{"id":"first"}]}\n'),
		tree('{"id":"agent-1","steps":[{"id":"first"},{"id":"third"}]}\n')
	);
	expect(orderedDiff.conflicts).toContain("agent.json.steps");
});

test("resolves a GitHub package folder and pins its commit", async () => {
	expect(parseGithubPackageReference("acme/agents")).toEqual({
		path: "",
		ref: "main",
		repository: "acme/agents",
	});
	expect(parseGithubPackageReference("acme/agents/demo@main")).toEqual({
		path: "demo",
		ref: "main",
		repository: "acme/agents",
	});
	expect(
		parseGithubPackageReference("https://github.com/acme/agents/tree/main/demo")
	).toEqual({ path: "demo", ref: "main", repository: "acme/agents" });

	const remoteManifest = {
		...manifest,
		id: "ryu/remote-agent",
		name: "Remote Agent",
		source: {
			type: "github",
			repository: "acme/agents",
			path: "demo",
			ref: "main",
		},
	};
	const fetcher = async (url: string): Promise<Response> => {
		if (url.includes("/commits/main")) {
			return new Response(JSON.stringify({ sha: "abc123" }), { status: 200 });
		}
		if (url.includes("/git/trees/abc123")) {
			return new Response(
				JSON.stringify({
					tree: [
						{ path: "demo/ryu.package.json", type: "blob" },
						{ path: "demo/agent.json", type: "blob" },
					],
				}),
				{ status: 200 }
			);
		}
		if (url.endsWith("demo/ryu.package.json")) {
			return new Response(JSON.stringify(remoteManifest), { status: 200 });
		}
		return new Response('{"template":{}}\n', { status: 200 });
	};
	const resolved = await readGithubPackage(
		"https://github.com/acme/agents/tree/main/demo",
		fetcher
	);
	expect(resolved.commit).toBe("abc123");
	expect(resolved.source.commit).toBe("abc123");
	expect(resolved.tree.manifest.source?.commit).toBeUndefined();
	expect(resolved.tree.files["agent.json"]).toBeDefined();
});

test("keeps encoded dot-segment GitHub entries inside the pinned package path", async () => {
	const encodedTraversalPath = "%2e%2e/%2e%2e/main/payload.json";
	const remoteManifest = {
		...manifest,
		id: "ryu/encoded-path-agent",
		name: "Encoded Path Agent",
	};
	const canonicalRawUrls: string[] = [];
	const fetcher = async (url: string): Promise<Response> => {
		if (url.includes("/commits/main")) {
			return new Response(JSON.stringify({ sha: "pinnedsha" }), {
				status: 200,
			});
		}
		if (url.includes("/git/trees/pinnedsha")) {
			return new Response(
				JSON.stringify({
					tree: [
						{ path: "demo/ryu.package.json", type: "blob" },
						{ path: "demo/agent.json", type: "blob" },
						{ path: `demo/${encodedTraversalPath}`, type: "blob" },
					],
				}),
				{ status: 200 }
			);
		}
		const canonicalUrl = new Request(url).url;
		canonicalRawUrls.push(canonicalUrl);
		if (canonicalUrl.endsWith("/demo/ryu.package.json")) {
			return new Response(JSON.stringify(remoteManifest), { status: 200 });
		}
		if (canonicalUrl.endsWith("/demo/agent.json")) {
			return new Response('{"template":{}}\n', { status: 200 });
		}
		if (
			canonicalUrl.endsWith("/demo/%252e%252e/%252e%252e/main/payload.json")
		) {
			return new Response("BYTES_FROM_PINNED_PACKAGE_PATH\n", { status: 200 });
		}
		if (canonicalUrl.endsWith("/main/payload.json")) {
			return new Response("BYTES_FROM_MUTABLE_REF\n", { status: 200 });
		}
		return new Response("not found", { status: 404 });
	};

	const resolved = await readGithubPackage(
		"https://github.com/acme/agents/tree/main/demo",
		fetcher
	);

	expect(canonicalRawUrls).toContain(
		"https://raw.githubusercontent.com/acme/agents/pinnedsha/demo/%252e%252e/%252e%252e/main/payload.json"
	);
	expect(canonicalRawUrls).not.toContain(
		"https://raw.githubusercontent.com/acme/agents/main/payload.json"
	);
	expect(resolved.source.commit).toBe("pinnedsha");
	expect(
		new TextDecoder().decode(resolved.tree.files[encodedTraversalPath])
	).toBe("BYTES_FROM_PINNED_PACKAGE_PATH\n");
});

test("prefers a local package path before GitHub shorthand resolution", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-package-local-input-"));
	try {
		await writePackageFolder(root, tree());
		const resolved = await readPackageInput(root);
		expect(resolved.manifest.id).toBe("ryu/example-agent");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects truncated or oversized GitHub tree responses", async () => {
	const truncatedFetcher = async (url: string): Promise<Response> => {
		if (url.includes("/commits/main")) {
			return new Response(JSON.stringify({ sha: "abc123" }), { status: 200 });
		}
		return new Response(JSON.stringify({ truncated: true, tree: [] }), {
			status: 200,
		});
	};
	await expect(
		readGithubPackage(
			"https://github.com/acme/agents/tree/main/demo",
			truncatedFetcher
		)
	).rejects.toThrow("tree was truncated");

	const oversizedFetcher = async (url: string): Promise<Response> => {
		if (url.includes("/commits/main")) {
			return new Response(JSON.stringify({ sha: "abc123" }), { status: 200 });
		}
		return new Response(
			JSON.stringify({
				tree: [
					{ path: "demo/ryu.package.json", type: "blob", size: 1 },
					{
						path: "demo/agent.json",
						type: "blob",
						size: 33 * 1024 * 1024,
					},
				],
			}),
			{ status: 200 }
		);
	};
	await expect(
		readGithubPackage(
			"https://github.com/acme/agents/tree/main/demo",
			oversizedFetcher
		)
	).rejects.toThrow("32 MiB limit");
});

test("bounds direct GitHub package response bodies and compressed archives", async () => {
	const oversizedFetcher = async (url: string): Promise<Response> => {
		if (url.includes("/commits/main")) {
			return new Response(JSON.stringify({ sha: "abc123" }), { status: 200 });
		}
		if (url.includes("/git/trees/abc123")) {
			return new Response(
				JSON.stringify({
					tree: [
						{ path: "demo/ryu.package.json", type: "blob" },
						{ path: "demo/agent.json", type: "blob" },
					],
				}),
				{ status: 200 }
			);
		}
		if (url.endsWith("demo/agent.json")) {
			return new Response("too large", {
				headers: { "content-length": String(33 * 1024 * 1024) },
				status: 200,
			});
		}
		return new Response(JSON.stringify(manifest), { status: 200 });
	};
	await expect(
		readGithubPackage(
			"https://github.com/acme/agents/tree/main/demo",
			oversizedFetcher
		)
	).rejects.toThrow("32 MiB limit");

	expect(() => unpackPackage(new Uint8Array(64 * 1024 * 1024 + 1))).toThrow(
		"compressed limit"
	);
});
