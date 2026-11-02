import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import * as publicEntry from "./index.ts";
import { diffPackageTrees } from "./package-diff.ts";
import { parseGithubPackageReference } from "./package-github.ts";
import { packPackage, unpackPackage } from "./package-io.ts";
import {
	manifestBytes,
	normalizePath,
	validatePackageManifest,
} from "./package-manifest.ts";
import { decryptSecrets, encryptSecrets } from "./package-secrets.ts";
import { packageSummary, validatePackageTree } from "./package-tree.ts";
import {
	PACKAGE_MANIFEST_FILE,
	type PackageTree,
	PackageValidationError,
} from "./package-types.ts";

const manifest = validatePackageManifest({
	artifacts: ["agent.json"],
	capabilities: [],
	id: "ryu/split-agent",
	kind: "agent",
	name: "Split Agent",
	requires: {},
	schemaVersion: 1,
	security: {
		containsSecrets: false,
		permissions: [],
		privateContent: false,
		redacted: true,
	},
	scopes: ["agent"],
	targets: ["desktop"],
	version: "1.0.0",
});

const tree: PackageTree = {
	files: { "agent.json": new TextEncoder().encode('{"name":"split"}\n') },
	manifest,
};

test("the public entry re-exports the split modules unchanged", () => {
	expect(publicEntry.validatePackageTree).toBe(validatePackageTree);
	expect(publicEntry.unpackPackage).toBe(unpackPackage);
	expect(publicEntry.diffPackageTrees).toBe(diffPackageTrees);
	expect(publicEntry.PackageValidationError).toBe(PackageValidationError);
	expect(publicEntry.PACKAGE_MANIFEST_FILE).toBe(PACKAGE_MANIFEST_FILE);
	expect("normalizePath" in publicEntry).toBe(false);
});

test("normalizePath refuses host-specific paths and keeps nested ones", () => {
	expect(normalizePath("./skills\\a.md")).toBe("skills/a.md");
	expect(() => normalizePath("C:/Windows/evil.dll")).toThrow(
		PackageValidationError
	);
	expect(() => normalizePath("notes/NUL.txt")).toThrow(PackageValidationError);
});

test("unpackPackage refuses an archive entry with a drive prefix", () => {
	const archive = zipSync({
		[PACKAGE_MANIFEST_FILE]: manifestBytes(manifest),
		"agent.json": new TextEncoder().encode("{}"),
		"C:/Users/Public/evil.txt": new TextEncoder().encode("x"),
	});
	expect(() => unpackPackage(archive)).toThrow(PackageValidationError);
});

test("pack and unpack round-trip through the split io module", () => {
	const restored = unpackPackage(packPackage(tree));
	expect(packageSummary(restored).checksum).toBe(packageSummary(tree).checksum);
});

test("GitHub references with a stream or drive path are rejected", () => {
	expect(parseGithubPackageReference("owner/repo/pkg:stream")).toBeNull();
	expect(parseGithubPackageReference("owner/repo/packages/agent")?.path).toBe(
		"packages/agent"
	);
});

test("secrets round-trip and a diff with no changes merges cleanly", () => {
	const sealed = encryptSecrets({ token: "t" }, "pass", manifest);
	expect(decryptSecrets(sealed, "pass", manifest)).toEqual({ token: "t" });
	const diff = diffPackageTrees(tree, tree, tree);
	expect(diff.conflicts).toEqual([]);
	expect(diff.merged?.files["agent.json"]).toEqual(tree.files["agent.json"]);
});
