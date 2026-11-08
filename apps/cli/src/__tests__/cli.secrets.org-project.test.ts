// `--org-project` and the project file's `orgProject`: `export` and `run`
// include one organization project's values (roadmap P1-15). Core is faked
// through the target's `fetch`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_FILE } from "../cli/secrets-project.ts";
import {
	environments,
	fakeNode,
	json,
	jsonExport,
	runSecrets,
} from "./secrets-fixture.ts";

let dir: string | null = null;
afterEach(async () => {
	if (dir) {
		await rm(dir, { recursive: true, force: true });
		dir = null;
	}
});

async function tempDir(): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "ryu-vault-org-project-"));
	return dir;
}

function exportBody(node: ReturnType<typeof fakeNode>) {
	const call = node.calls.find((entry) => entry.path === "/api/vault/export");
	return JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
}

test("export --org-project asks Core for that project's values", async () => {
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({ DB_URL: "postgres://p" })),
	});
	const result = await runSecrets(
		["export", "--no-project", "--format", "json", "--org-project", "proj-1"],
		node
	);
	expect(result.code).toBe(0);
	expect(exportBody(node).projectId).toBe("proj-1");

	const plain = fakeNode({
		"POST /api/vault/export": json(jsonExport({})),
	});
	await runSecrets(["export", "--no-project", "--format", "json"], plain);
	expect(exportBody(plain)).not.toHaveProperty("projectId");
});

test("run takes the organization project from the project file unless a flag sets it", async () => {
	const cwd = await tempDir();
	await writeFile(
		join(cwd, PROJECT_FILE),
		JSON.stringify({ version: 1, environment: "dev", orgProject: "proj-1" })
	);
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({ DB_URL: "postgres://p" })),
	});
	let childEnv: Record<string, string> = {};
	const result = await runSecrets(["run", "--", "node", "app.js"], node, {
		cwd,
		spawn: (_cmd, env) => {
			childEnv = env;
			return Promise.resolve(0);
		},
	});
	expect(result.code).toBe(0);
	expect(result.err).toContain("including organization project proj-1");
	expect(exportBody(node)).toMatchObject({
		environment: "dev",
		projectId: "proj-1",
	});
	expect(childEnv.DB_URL).toBe("postgres://p");

	const flagged = fakeNode({
		"POST /api/vault/export": json(jsonExport({})),
	});
	await runSecrets(["run", "--org-project", "proj-2", "--", "true"], flagged, {
		cwd,
		spawn: () => Promise.resolve(0),
	});
	expect(exportBody(flagged).projectId).toBe("proj-2");

	// Other value commands never take it.
	const listed = fakeNode({ "GET /api/vault/secrets": json({ secrets: [] }) });
	await runSecrets(["list"], listed, { cwd });
	expect(listed.calls[0]?.path).not.toContain("proj-1");
});

test("init records --org-project, and a project file with a malformed one is refused", async () => {
	const cwd = await tempDir();
	const node = fakeNode({
		"GET /api/vault/environments": json(environments("dev")),
	});
	const result = await runSecrets(
		["init", "--env", "dev", "--org-project", "proj-1"],
		node,
		{ cwd }
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(await readFile(join(cwd, PROJECT_FILE), "utf8"))).toEqual({
		version: 1,
		environment: "dev",
		orgProject: "proj-1",
	});

	await writeFile(
		join(cwd, PROJECT_FILE),
		JSON.stringify({ version: 1, orgProject: "has space" })
	);
	const refused = await runSecrets(["export"], fakeNode({}), { cwd });
	expect(refused.code).toBe(2);
	expect(refused.err).toContain(PROJECT_FILE);
});

test("--org-project is refused with a machine token", async () => {
	const node = fakeNode({});
	const result = await runSecrets(
		["export", "--no-project", "--org-project", "proj-1"],
		node,
		{ env: { RYU_VAULT_TOKEN: "hvs.x", RYU_CORE_TOKEN: "node-token" } }
	);
	expect(result.code).toBe(2);
	expect(result.err).toContain("--org-project is not supported");
	expect(node.calls).toHaveLength(0);
});
