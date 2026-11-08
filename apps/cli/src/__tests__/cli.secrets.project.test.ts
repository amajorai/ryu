// `ryu-cli secrets init`, `.ryu-vault.json` defaults (parent-directory
// search), `--tags`, `destroy`, and `snapshot`. Core is faked through the
// target's `fetch`; project files live in a temporary directory.

import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProject, PROJECT_FILE } from "../cli/secrets-project.ts";
import { namesWithTags } from "../cli/secrets-run-env.ts";
import {
	environments,
	fakeNode,
	json,
	jsonExport,
	listBody,
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
	dir = await mkdtemp(join(tmpdir(), "ryu-vault-project-"));
	return dir;
}

test("init writes the project file after checking the environment, and refuses to overwrite it", async () => {
	const cwd = await tempDir();
	const node = fakeNode({
		"GET /api/vault/environments": json(environments("dev", "prod")),
	});
	const first = await runSecrets(
		["init", "--env", "dev", "--path", "/api", "--tags", "backend,db"],
		node,
		{ cwd }
	);
	expect(first.code).toBe(0);
	const written = JSON.parse(await readFile(join(cwd, PROJECT_FILE), "utf8"));
	expect(written).toEqual({
		version: 1,
		environment: "dev",
		path: "/api",
		tags: ["backend", "db"],
	});
	const again = await runSecrets(["init", "--env", "prod"], node, { cwd });
	expect(again.code).toBe(2);
	expect(again.err).toContain("already exists");
	const forced = await runSecrets(["init", "--env", "prod", "--force"], node, {
		cwd,
	});
	expect(forced.code).toBe(0);
	expect(
		JSON.parse(await readFile(join(cwd, PROJECT_FILE), "utf8")).environment
	).toBe("prod");
});

test("init refuses an environment the node does not have and writes nothing", async () => {
	const cwd = await tempDir();
	const node = fakeNode({
		"GET /api/vault/environments": json(environments("dev")),
	});
	const result = await runSecrets(["init", "--env", "staging"], node, { cwd });
	expect(result.code).toBe(2);
	expect(result.err).toContain("No environment 'staging'");
	await expect(stat(join(cwd, PROJECT_FILE))).rejects.toThrow();
});

test("value commands take env, path, and tags from the nearest parent project file", async () => {
	const root = await tempDir();
	const nested = join(root, "services", "api");
	await mkdir(nested, { recursive: true });
	await writeFile(
		join(root, PROJECT_FILE),
		JSON.stringify({
			version: 1,
			environment: "dev",
			path: "/api",
			tags: ["backend"],
		})
	);
	expect((await findProject(nested))?.file).toBe(join(root, PROJECT_FILE));
	const node = fakeNode({
		"GET /api/vault/secrets": json(
			listBody([secretRow("DB_URL", ["backend"]), secretRow("OTHER", [])])
		),
		"POST /api/vault/export": json(jsonExport({ DB_URL: "postgres://x" })),
	});
	let childEnv: Record<string, string> = {};
	const result = await runSecrets(["run", "--", "node", "app.js"], node, {
		cwd: nested,
		spawn: (_cmd, env) => {
			childEnv = env;
			return Promise.resolve(0);
		},
	});
	expect(result.code).toBe(0);
	expect(node.calls[0]?.path).toBe(
		"/api/vault/secrets?environment=dev&path=%2Fapi"
	);
	expect(JSON.parse(node.calls[1]?.body ?? "{}")).toEqual({
		environment: "dev",
		path: "/api",
		format: "json",
		names: ["DB_URL"],
	});
	expect(childEnv.DB_URL).toBe("postgres://x");

	// A flag wins over the file, and --no-project ignores it.
	const flagged = fakeNode({ "GET /api/vault/secrets": json(listBody([])) });
	await runSecrets(["list", "--env", "prod"], flagged, { cwd: nested });
	expect(flagged.calls[0]?.path).toBe(
		"/api/vault/secrets?environment=prod&path=%2Fapi"
	);
	const ignored = fakeNode({ "GET /api/vault/secrets": json(listBody([])) });
	await runSecrets(["list", "--no-project"], ignored, { cwd: nested });
	expect(ignored.calls[0]?.path).toBe("/api/vault/secrets");
});

test("an invalid project file is a usage error naming the file", async () => {
	const cwd = await tempDir();
	await writeFile(
		join(cwd, PROJECT_FILE),
		JSON.stringify({ version: 1, environment: "dev", token: "x" })
	);
	const node = fakeNode({});
	const result = await runSecrets(["list"], node, { cwd });
	expect(result.code).toBe(2);
	expect(result.err).toContain(PROJECT_FILE);
	expect(node.calls).toHaveLength(0);
});

test("--tags keeps only names whose every visible row carries a tag", async () => {
	expect(
		namesWithTags(
			[
				secretRow("A", ["web"]),
				secretRow("B", ["db"]),
				secretRow("B", [], "node"),
				secretRow("C", []),
			],
			["web", "db"]
		)
	).toEqual(["A"]);
	const node = fakeNode({
		"GET /api/vault/secrets": json(listBody([secretRow("C", [])])),
		"POST /api/vault/export": json({
			...jsonExport({}),
			format: "dotenv",
			content: "",
		}),
	});
	const result = await runSecrets(
		["export", "--no-project", "--tags", "web"],
		node
	);
	expect(result.code).toBe(0);
	expect(result.err).toContain("No values carry the tags web");
	// No match still restricts the export to nothing.
	expect(JSON.parse(node.calls[1]?.body ?? "{}").names).toEqual([]);
});

test("--tags is refused with a machine token, which cannot list tags", async () => {
	const node = fakeNode({});
	const result = await runSecrets(
		["run", "--no-project", "--tags", "web", "--", "true"],
		node,
		{ env: { RYU_VAULT_TOKEN: "hvs.x", RYU_CORE_TOKEN: "node-token" } }
	);
	expect(result.code).toBe(2);
	expect(result.err).toContain("--tags is not supported with RYU_VAULT_TOKEN");
});

test("destroy needs explicit versions or --all", async () => {
	const node = fakeNode({
		"POST /api/vault/secrets/API_KEY/destroy": json({ ok: true, destroyed: 2 }),
	});
	const bare = await runSecrets(["destroy", "API_KEY", "--no-project"], node);
	expect(bare.code).toBe(2);
	expect(node.calls).toHaveLength(0);
	const some = await runSecrets(
		["destroy", "API_KEY", "1", "2", "--no-project"],
		node
	);
	expect(some.code).toBe(0);
	expect(some.out).toContain("Destroyed 2 version(s) of API_KEY.");
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
		scope: "user",
		versions: [1, 2],
	});
	await runSecrets(["destroy", "API_KEY", "--all", "--no-project"], node);
	expect(JSON.parse(node.calls[1]?.body ?? "{}")).toEqual({ scope: "user" });
});

const ENVELOPE = {
	format: "ryu-vault-snapshot",
	version: 1,
	createdAt: "2026-01-01T00:00:00Z",
	kdf: { alg: "pbkdf2-sha256", iterations: 600_000, salt: "c2FsdA" },
	nonce: "bm9uY2U",
	ciphertext: "Y2lwaGVy",
};

test("snapshot seals with RYU_VAULT_PASSPHRASE and writes a private file", async () => {
	const cwd = await tempDir();
	const node = fakeNode({ "POST /api/vault/snapshot": json(ENVELOPE) });
	const missing = await runSecrets(["snapshot", "--no-project"], node);
	expect(missing.code).toBe(2);
	expect(node.calls).toHaveLength(0);
	const out = join(cwd, "vault.snapshot.json");
	const result = await runSecrets(
		["snapshot", "--no-project", "--env", "prod", "--out", out],
		node,
		{ env: { RYU_VAULT_PASSPHRASE: "correct horse" } }
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
		passphrase: "correct horse",
		environment: "prod",
	});
	expect(JSON.parse(await readFile(out, "utf8"))).toEqual(ENVELOPE);
	expect((await stat(out)).mode & 0o777).toBe(0o600);
	expect(result.out).toBe("");
	const again = await runSecrets(
		["snapshot", "--no-project", "--out", out],
		node,
		{ env: { RYU_VAULT_PASSPHRASE: "correct horse" } }
	);
	expect(again.code).toBe(2);
});

test("an AI agent session cannot print a snapshot", async () => {
	const node = fakeNode({ "POST /api/vault/snapshot": json(ENVELOPE) });
	const result = await runSecrets(["snapshot", "--no-project"], node, {
		env: { CLAUDECODE: "1", RYU_VAULT_PASSPHRASE: "p" },
	});
	expect(result.code).toBe(1);
	expect(node.calls).toHaveLength(0);
});

test("a project file that sets the target is named on stderr", async () => {
	const cwd = await tempDir();
	await writeFile(
		join(cwd, PROJECT_FILE),
		JSON.stringify({ version: 1, environment: "dev", path: "/api" })
	);
	const node = fakeNode({ "GET /api/vault/secrets": json(listBody([])) });
	const result = await runSecrets(["list"], node, { cwd });
	expect(result.code).toBe(0);
	expect(result.err).toContain(
		`using environment dev, folder /api from ${join(cwd, PROJECT_FILE)}`
	);
	// Flags that set the whole target leave nothing to announce.
	const flagged = await runSecrets(
		["list", "--env", "prod", "--path", "/"],
		node,
		{ cwd }
	);
	expect(flagged.err).not.toContain(PROJECT_FILE);
});

test("delete and destroy never take their target from a project file", async () => {
	const cwd = await tempDir();
	await writeFile(
		join(cwd, PROJECT_FILE),
		JSON.stringify({ version: 1, environment: "prod" })
	);
	const node = fakeNode({
		"POST /api/vault/secrets/API_KEY/destroy": json({ ok: true, destroyed: 2 }),
	});
	for (const subcommand of ["destroy", "delete"]) {
		const refused = await runSecrets([subcommand, "API_KEY", "--all"], node, {
			cwd,
		});
		expect(refused.code).toBe(2);
		expect(refused.err).toContain("Pass --env prod to confirm it");
	}
	expect(node.calls).toHaveLength(0);
	const confirmed = await runSecrets(
		["destroy", "API_KEY", "--all", "--env", "prod"],
		node,
		{ cwd }
	);
	expect(confirmed.code).toBe(0);
	expect(JSON.parse(node.calls[0]?.body ?? "{}").environment).toBe("prod");
});
