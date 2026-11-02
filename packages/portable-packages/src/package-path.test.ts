import { expect, test } from "bun:test";
import {
	PackageValidationError,
	packageDigest,
	validatePackageManifest,
	validatePackageTree,
} from "./index.ts";
import { isPortablePackagePath } from "./package-path.ts";

const manifest = validatePackageManifest({
	artifacts: ["agent.json"],
	capabilities: [],
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
});

function treeWith(path: string) {
	return {
		files: {
			"agent.json": new TextEncoder().encode("{}"),
			[path]: new TextEncoder().encode("payload"),
		},
		manifest,
	};
}

const UNSAFE_PATHS = [
	"C:/evil.txt",
	"C:evil.txt",
	"C:\\evil.txt",
	"dir/C:",
	"a/b:stream",
	"skills/CON",
	"skills/nul.txt",
	"skills/a?b.md",
	"skills/a\u0000b.md",
];

test("rejects Windows drive prefixes, streams, devices and invalid names", () => {
	for (const path of UNSAFE_PATHS) {
		expect(() => validatePackageTree(treeWith(path))).toThrow(
			PackageValidationError
		);
		expect(() => packageDigest(treeWith(path))).toThrow(PackageValidationError);
	}
});

test("keeps ordinary nested package paths valid", () => {
	expect(isPortablePackagePath("skills/a.md")).toBe(true);
	expect(isPortablePackagePath("skills/console.md")).toBe(true);
	expect(() => validatePackageTree(treeWith("notes/readme.md"))).not.toThrow();
	expect(isPortablePackagePath("../escape")).toBe(false);
	expect(isPortablePackagePath("/absolute")).toBe(false);
});
