// `ryu-cli secrets run --recursive`, local `.env` layering (`--dotenv`,
// `--env-file`, `--dotenv-override`), and `example-env`. Core is faked through
// the target's `fetch`; local files live in a temporary directory.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VaultSecret } from "@ryuhq/core-client/vault";
import { exampleEntries, renderExample } from "../cli/secrets-example-env.ts";
import { SUBCOMMAND_HELP } from "../cli/secrets-help.ts";
import { DEVLOOP_HELP_LINES } from "../cli/secrets-help-devloop.ts";
import { parseDotenv } from "../cli/secrets-local-env.ts";
import { normalizeFolder, subFolders } from "../cli/secrets-recursive.ts";
import {
	fakeNode,
	json,
	jsonExport,
	listBody,
	type NodeCall,
	runSecrets,
	secretRow,
} from "./secrets-fixture.ts";

let dir: string | null = null;
afterEach(async () => {
	if (dir) {
		await rm(dir, { recursive: true, force: true });
		dir = null;
	}
});

async function tempDir(): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "ryu-vault-layers-"));
	return dir;
}

function row(name: string, path: string, extra: Partial<VaultSecret> = {}) {
	return { ...secretRow(name, []), path, ...extra };
}

/** Export replies keyed by the folder in the request body. */
function exportsByPath(byPath: Record<string, Record<string, string>>) {
	return (call: NodeCall) => {
		const path = JSON.parse(call.body).path ?? "/";
		return Response.json(jsonExport(byPath[path] ?? {}));
	};
}

async function runCapturing(
	argv: string[],
	node: ReturnType<typeof fakeNode>,
	cwd?: string
) {
	let childEnv: Record<string, string> = {};
	const result = await runSecrets(argv, node, {
		cwd,
		spawn: (_cmd, env) => {
			childEnv = env;
			return Promise.resolve(0);
		},
	});
	return { ...result, childEnv };
}

test("--recursive adds sub-folder values without letting an inherited value clobber a sibling's own", async () => {
	// /api overrides A; its sibling /web only inherits A from /. The run's
	// folder (/) wins for its own names; sub-folders only fill in.
	const node = fakeNode({
		"GET /api/vault/secrets": json(
			listBody([
				row("ROOT", "/"),
				row("A", "/api"),
				row("API_KEY", "/api"),
				row("WEB_KEY", "/web"),
				row("DEEP", "/web/deep"),
				row("API_KEY", "/web/deep"),
				row("GONE", "/old", { status: "deleted" }),
			])
		),
		"POST /api/vault/export": exportsByPath({
			"/": { ROOT: "r" },
			"/api": { ROOT: "r", A: "api-a", API_KEY: "k1" },
			"/web": { ROOT: "r", A: "inherited", WEB_KEY: "w" },
			"/web/deep": { ROOT: "r", WEB_KEY: "w", DEEP: "d", API_KEY: "k2" },
		}),
	});
	const result = await runCapturing(
		["run", "--env", "dev", "--recursive", "--", "app"],
		node
	);
	expect(result.code).toBe(0);
	expect(result.childEnv).toMatchObject({
		ROOT: "r",
		A: "api-a",
		API_KEY: "k1",
		WEB_KEY: "w",
		DEEP: "d",
	});
	expect(result.err).toContain(
		"API_KEY in /web/deep is ignored: /api already sets it."
	);
	expect(result.err).not.toContain("k2");
	const exported = node.calls
		.filter((call) => call.route === "POST /api/vault/export")
		.map((call) => JSON.parse(call.body).path ?? "/");
	expect(exported).toEqual(["/", "/api", "/web", "/web/deep"]);
	const list = node.calls.find(
		(call) => call.route === "GET /api/vault/secrets"
	);
	expect(list?.path).toContain("recursive=true");
});

test("without --recursive only the folder's own export is used", async () => {
	const node = fakeNode({
		"POST /api/vault/export": exportsByPath({ "/": { ROOT: "r" } }),
	});
	const result = await runCapturing(["run", "--", "app"], node);
	expect(result.childEnv.ROOT).toBe("r");
	expect(node.calls.map((call) => call.route)).toEqual([
		"POST /api/vault/export",
	]);
});

test("--recursive is refused with a machine token", async () => {
	const node = fakeNode({});
	const result = await runSecrets(["run", "--recursive", "--", "app"], node, {
		env: { HOME: "/home/me", RYU_VAULT_TOKEN: "vt" },
		target: { ...node.target, url: "https://node.test" },
	});
	expect(result.code).toBe(2);
	expect(result.err).toContain(
		"--recursive is not supported with RYU_VAULT_TOKEN"
	);
});

test("--dotenv fills in names the vault does not set, .env.local over .env", async () => {
	const cwd = await tempDir();
	await writeFile(
		join(cwd, ".env"),
		'SHARED=from-env\nONLY_ENV=1\nexport QUOTED="a\\nb"\n'
	);
	await writeFile(join(cwd, ".env.local"), "SHARED=from-local # note\n");
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({ SHARED: "vault", API: "v" })),
	});
	const result = await runCapturing(
		["run", "--dotenv", "--", "app"],
		node,
		cwd
	);
	expect(result.code).toBe(0);
	expect(result.childEnv).toMatchObject({
		SHARED: "vault",
		API: "v",
		ONLY_ENV: "1",
		QUOTED: "a\nb",
	});
	expect(result.err).toContain("fill in names the vault does not set");
	expect(result.err).not.toContain("vault\n");
});

test("--dotenv-override lets local files win, and --env-file comes last", async () => {
	const cwd = await tempDir();
	await writeFile(join(cwd, ".env"), "SHARED=from-env\n");
	await writeFile(join(cwd, ".env.local"), "SHARED=from-local\n");
	await writeFile(join(cwd, "ci.env"), "SHARED=from-file\nEXTRA='x # y'\n");
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({ SHARED: "vault", API: "v" })),
	});
	const result = await runCapturing(
		[
			"run",
			"--dotenv",
			"--env-file",
			"ci.env",
			"--dotenv-override",
			"--",
			"app",
		],
		node,
		cwd
	);
	expect(result.code).toBe(0);
	expect(result.childEnv).toMatchObject({
		SHARED: "from-file",
		API: "v",
		EXTRA: "x # y",
	});
});

test("a missing --env-file and a malformed line fail without printing values", async () => {
	const cwd = await tempDir();
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({ API: "v" })),
	});
	const missing = await runCapturing(
		["run", "--env-file", "nope.env", "--", "app"],
		node,
		cwd
	);
	expect(missing.code).toBe(2);
	expect(missing.err).toContain("nope.env does not exist");
	await writeFile(join(cwd, "bad.env"), "OK=1\nnot a line s3cr3t\n");
	const bad = await runCapturing(
		["run", "--env-file", "bad.env", "--", "app"],
		node,
		cwd
	);
	expect(bad.code).toBe(2);
	expect(bad.err).toContain("bad.env:2: expected KEY=value.");
	expect(bad.err).not.toContain("s3cr3t");
});

test("local layering and --recursive are refused with --broker", async () => {
	const node = fakeNode({});
	for (const flags of [
		["--dotenv"],
		["--env-file", "a.env"],
		["--recursive"],
	]) {
		const result = await runSecrets(
			["run", "--broker", "github", ...flags, "--", "app"],
			node
		);
		expect(result.code).toBe(2);
		expect(result.err).toContain("apply to value runs");
	}
	expect(node.calls).toHaveLength(0);
});

test("--dotenv-override alone is a usage error", async () => {
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({})),
	});
	const result = await runSecrets(
		["run", "--dotenv-override", "--", "app"],
		node
	);
	expect(result.code).toBe(2);
	expect(result.err).toContain(
		"--dotenv-override needs --dotenv or --env-file"
	);
});

test("parseDotenv handles comments, export, quotes and duplicates", () => {
	expect(
		parseDotenv(
			'﻿# c\n\nA=1\nexport B = two words # tail\nC=\'lit\\n\'\nD="q\\"x"\nA=2\nE=\n',
			"f"
		)
	).toEqual({ A: "2", B: "two words", C: "lit\\n", D: 'q"x', E: "" });
	expect(() => parseDotenv('A="open\n', "f")).toThrow("f:1:");
	expect(() => parseDotenv("=x\n", "f")).toThrow("f:1: expected KEY=value.");
});

test("subFolders groups live rows below the root, shallowest first", () => {
	const folders = subFolders(
		[row("X", "/a/b"), row("Y", "/a"), row("Z", "/ab"), row("W", "/a/")],
		"/a"
	);
	expect(folders.map(([path, names]) => [path, [...names]])).toEqual([
		["/a/b", ["X"]],
	]);
	expect(normalizeFolder("api/")).toBe("/api");
	expect(normalizeFolder(undefined)).toBe("/");
});

const EXAMPLE_ROWS = [
	row("ROOT_URL", "/", {
		metadata: { ...secretRow("x", []).metadata, description: "Base\nURL" },
	}),
	row("API_KEY", "/api"),
	row("DEEP", "/api/deep"),
	row("OTHER", "/web"),
	row("SEALED", "/api", {
		metadata: { ...secretRow("x", []).metadata, valueType: "sealed" },
	}),
	row("OLD", "/api", { status: "deleted" }),
];

test("example-env prints the names run would inject, never a value, and never exports", async () => {
	const node = fakeNode({
		"GET /api/vault/secrets": json(listBody(EXAMPLE_ROWS)),
	});
	const plain = await runSecrets(
		["example-env", "--env", "dev", "--path", "/api"],
		node
	);
	expect(plain.code).toBe(0);
	expect(plain.out).toContain("# Base URL\nROOT_URL=\n");
	expect(plain.out).toContain("API_KEY=\n");
	expect(plain.out).not.toContain("DEEP=");
	expect(plain.out).not.toContain("OTHER=");
	expect(plain.out).not.toContain("SEALED=");
	expect(plain.out).not.toContain("OLD=");
	const deep = await runSecrets(
		["example-env", "--env", "dev", "--path", "/api", "--recursive", "--json"],
		node
	);
	expect(JSON.parse(deep.out)).toEqual({
		names: ["API_KEY", "DEEP", "ROOT_URL"],
	});
	expect(
		node.calls.every((call) => call.route === "GET /api/vault/secrets")
	).toBe(true);
});

test("example-env --out writes the file and refuses to overwrite it without --force", async () => {
	const cwd = await tempDir();
	const node = fakeNode({
		"GET /api/vault/secrets": json(listBody(EXAMPLE_ROWS)),
	});
	const first = await runSecrets(
		["example-env", "--path", "/api", "--out", ".env.example"],
		node,
		{ cwd }
	);
	expect(first.code).toBe(0);
	expect(first.out).toContain("Wrote 2 names to .env.example.");
	const text = await readFile(join(cwd, ".env.example"), "utf8");
	expect(text.split("\n").filter((line) => line.includes("="))).toEqual(
		["ROOT_URL=", "API_KEY="].sort()
	);
	const again = await runSecrets(
		["example-env", "--out", ".env.example"],
		node,
		{ cwd }
	);
	expect(again.code).toBe(2);
	expect(again.err).toContain("already exists");
	const forced = await runSecrets(
		["example-env", "--out", ".env.example", "--force"],
		node,
		{ cwd }
	);
	expect(forced.code).toBe(0);
});

test("help lists the new developer-loop commands", async () => {
	for (const line of DEVLOOP_HELP_LINES) {
		expect(SUBCOMMAND_HELP).toContain(line);
	}
	const result = await runSecrets(["help"], fakeNode({}));
	expect(result.out).toContain("example-env");
	expect(result.out).toContain("access request PATH");
});

test("exampleEntries keeps the first description and tags narrow the names", () => {
	const tagged = {
		...row("TAGGED", "/"),
		metadata: { ...secretRow("x", ["api"]).metadata },
	};
	const entries = exampleEntries([...EXAMPLE_ROWS, tagged], "/", false, [
		"api",
	]);
	expect(entries).toEqual([{ name: "TAGGED", description: "" }]);
	expect(renderExample(entries).endsWith("\nTAGGED=\n")).toBe(true);
});
