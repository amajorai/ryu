// `ryu-cli package …` wiring: export redacts by default, `--include-secrets`
// is refused without an encrypted envelope, `pack` derives its destination,
// `publish` rejects secret-bearing packages, and `validate --json` reports the
// summary. Packages are real folders/archives in a temp dir; no Core is called.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PackageTree,
	readPackageFolder,
	readPackageInput,
	validatePackageManifest,
	withEncryptedSecrets,
	writePackageFolder,
} from "@ryu/portable-packages";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };
const encoder = new TextEncoder();

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

function plainTree(): PackageTree {
	return {
		files: {
			"agent.json": encoder.encode('{"id":"agent-1"}\n'),
			"README.md": encoder.encode("# Example\n"),
		},
		manifest: validatePackageManifest(manifest),
	};
}

function secretTree(): PackageTree {
	const base = plainTree();
	return withEncryptedSecrets(
		{
			...base,
			files: {
				...base.files,
				"content/private.md": encoder.encode("private notes"),
				"credentials.json": encoder.encode('{"token":"do-not-leak"}'),
			},
		},
		{ token: "do-not-leak" },
		"correct horse"
	);
}

let dir = "";
let savedKey: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ryu-cli-package-"));
	savedKey = process.env.RYU_PACKAGE_KEY;
	process.env.RYU_PACKAGE_KEY = "correct horse";
});

afterEach(() => {
	if (savedKey === undefined) {
		delete process.env.RYU_PACKAGE_KEY;
	} else {
		process.env.RYU_PACKAGE_KEY = savedKey;
	}
	rmSync(dir, { recursive: true, force: true });
});

function noCoreApi(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		disableApp: notCalled,
		enableApp: notCalled,
		execAppCommand: notCalled,
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		streamChat: notCalled,
		uninstallApp: notCalled,
	};
}

async function run(argv: string[]) {
	let out = "";
	let err = "";
	const io: CliIO = {
		out: (chunk) => {
			out += chunk;
		},
		err: (chunk) => {
			err += chunk;
		},
	};
	const code = await runCli(argv, { api: noCoreApi(), io, target });
	return { code, err, out };
}

async function writeSource(tree: PackageTree, name = "src"): Promise<string> {
	const path = join(dir, name);
	await writePackageFolder(path, tree);
	return path;
}

test("export without --include-secrets writes a redacted folder", async () => {
	const src = await writeSource(secretTree());
	const dest = join(dir, "out");
	const result = await run(["package", "export", src, dest, "--json"]);
	expect(result.code).toBe(0);
	const report = JSON.parse(result.out);
	expect(report.redacted).toBe(true);
	expect(report.destination).toBe(dest);
	expect(existsSync(join(dest, "secrets.enc"))).toBe(false);
	expect(existsSync(join(dest, "credentials.json"))).toBe(false);
	expect(existsSync(join(dest, "content", "private.md"))).toBe(false);
	expect(existsSync(join(dest, "agent.json"))).toBe(true);
	const written = await readPackageFolder(dest);
	expect(written.manifest.security.containsSecrets).toBe(false);
	expect(written.manifest.security.redacted).toBe(true);
	expect(JSON.stringify(report)).not.toContain("do-not-leak");
});

test("export to a .ryupack archive is redacted too", async () => {
	const src = await writeSource(secretTree());
	const dest = join(dir, "out.ryupack");
	expect((await run(["package", "export", src, dest])).code).toBe(0);
	const archived = await readPackageInput(dest);
	expect(archived.files["secrets.enc"]).toBeUndefined();
	expect(archived.files["credentials.json"]).toBeUndefined();
	expect(Object.keys(archived.files).sort()).toEqual([
		"README.md",
		"agent.json",
	]);
});

test("--include-secrets without a secrets.enc envelope fails and writes nothing", async () => {
	const unencrypted = plainTree();
	const src = await writeSource({
		...unencrypted,
		files: {
			...unencrypted.files,
			"credentials.json": encoder.encode('{"token":"plain"}'),
		},
	});
	const dest = join(dir, "out");
	const result = await run([
		"package",
		"export",
		src,
		dest,
		"--include-secrets",
	]);
	expect(result.code).toBe(1);
	expect(result.err).toContain(
		"requires a package that already contains an encrypted secrets.enc envelope"
	);
	expect(existsSync(dest)).toBe(false);
});

test("--include-secrets keeps the envelope only after it unlocks", async () => {
	const src = await writeSource(secretTree());
	const dest = join(dir, "out");
	process.env.RYU_PACKAGE_KEY = "wrong key";
	const refused = await run([
		"package",
		"export",
		src,
		dest,
		"--include-secrets",
	]);
	expect(refused.code).toBe(1);
	expect(existsSync(dest)).toBe(false);

	process.env.RYU_PACKAGE_KEY = "correct horse";
	const ok = await run([
		"package",
		"export",
		src,
		dest,
		"--include-secrets",
		"--json",
	]);
	expect(ok.code).toBe(0);
	expect(JSON.parse(ok.out).redacted).toBe(false);
	expect(existsSync(join(dest, "secrets.enc"))).toBe(true);
});

test("pack with no destination writes <dir>.ryupack, stripping a trailing slash", async () => {
	const src = await writeSource(plainTree());
	const result = await run(["package", "pack", `${src}/`, "--json"]);
	expect(result.code).toBe(0);
	const expected = `${src}.ryupack`;
	expect(JSON.parse(result.out).destination).toBe(expected);
	expect(existsSync(expected)).toBe(true);
	expect(existsSync(join(`${src}/`, ".ryupack"))).toBe(false);
	const packed = await readPackageInput(expected);
	expect(packed.manifest.id).toBe("ryu/example-agent");
	expect(Object.keys(packed.files).sort()).toEqual(["README.md", "agent.json"]);
});

test("publish refuses a secret-bearing package", async () => {
	const src = await writeSource(secretTree());
	const result = await run(["package", "publish", src]);
	expect(result.code).toBe(1);
	expect(result.out).not.toContain("is publishable");
});

test("publish accepts a clean package", async () => {
	const src = await writeSource(plainTree());
	const result = await run(["package", "publish", src, "--json"]);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.out).publishable).toBe(true);
});

test("validate --json emits the id, version, kind and file list", async () => {
	const src = await writeSource(plainTree());
	const result = await run(["pkg", "validate", src, "--json"]);
	expect(result.code).toBe(0);
	const summary = JSON.parse(result.out);
	expect(summary.id).toBe("ryu/example-agent");
	expect(summary.version).toBe("1.0.0");
	expect(summary.kind).toBe("agent");
	expect(summary.files).toEqual(
		expect.arrayContaining(["agent.json", "README.md"])
	);
	expect(readFileSync(join(src, "agent.json"), "utf8")).toContain("agent-1");
});

test("bare package and an unknown action are usage errors", async () => {
	const bare = await run(["package"]);
	expect(bare.code).toBe(2);
	expect(bare.err).toContain("Usage");
	const unknown = await run(["package", "explode", dir]);
	expect(unknown.code).toBe(2);
	const missingDest = await run(["package", "export", dir]);
	expect(missingDest.code).toBe(2);
});
