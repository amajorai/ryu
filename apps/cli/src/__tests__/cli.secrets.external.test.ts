// `ryu-cli secrets external …`: stores from a file, secret syncs, and sources.
// Core is faked through the target's `fetch`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStoreFile } from "../cli/secrets-external.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

let dir: string | null = null;
afterEach(async () => {
	if (dir) {
		await rm(dir, { recursive: true, force: true });
		dir = null;
	}
});

const store = {
	id: "xs_1",
	name: "acme-ci",
	kind: "github-actions",
	address: "https://api.github.com",
	authMethod: "token",
	repository: "acme/app",
	mount: "",
	pathPrefix: "",
	projectId: "",
	createdAt: 1,
	updatedAt: 1,
};

const destination = {
	id: "xdst_1",
	storeId: "xs_1",
	environment: "prod",
	path: "/web",
	remotePath: "WEB_",
	dirty: false,
	failures: 1,
	intervalSecs: 3600,
	lastCount: 2,
	lastError: "GitHub secret write failed with HTTP 403",
	lastPushAt: 5,
	lastStatus: "error",
};

test("add reads the store from a file and never puts credentials in the output", async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-external-"));
	const file = join(dir, "gh.json");
	await writeFile(
		file,
		JSON.stringify({
			name: "acme-ci",
			kind: "github-actions",
			authMethod: "token",
			repository: "acme/app",
			credentials: { token: "ghp_very_secret" },
		})
	);
	const node = fakeNode({
		"POST /api/vault/external/stores": json({ store }),
	});
	const result = await runSecrets(["external", "add", file], node);
	expect(result.code).toBe(0);
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toMatchObject({
		kind: "github-actions",
		repository: "acme/app",
		credentials: { token: "ghp_very_secret" },
	});
	expect(result.out).toContain("acme-ci");
	expect(result.out).not.toContain("ghp_very_secret");
});

test("store files are validated without echoing values, and key-file objects become text", () => {
	expect(() => parseStoreFile("{not json", "s.json")).toThrow("s.json");
	expect(() =>
		parseStoreFile(
			JSON.stringify({ kind: "vercel", credentials: { token: "tok_secret" } }),
			"s.json"
		)
	).toThrow(/^(?!.*tok_secret).*name is required/);
	expect(() =>
		parseStoreFile(
			JSON.stringify({
				name: "v",
				kind: "vercel",
				authMethod: "token",
				credentials: { token: 42 },
			}),
			"s.json"
		)
	).toThrow("credentials.token is invalid");
	const parsed = parseStoreFile(
		JSON.stringify({
			name: "gcp",
			kind: "gcp-secret-manager",
			authMethod: "service-account",
			projectId: "proj-1",
			credentials: {
				serviceAccountKey: { type: "service_account", client_email: "a@b" },
			},
		}),
		"gcp.json"
	);
	expect(parsed.credentials.serviceAccountKey).toBe(
		'{"type":"service_account","client_email":"a@b"}'
	);
});

test("sync resolves the store by name and creates a destination with a prefix and interval", async () => {
	const node = fakeNode({
		"GET /api/vault/external/stores": json({ stores: [store] }),
		"POST /api/vault/external/destinations": json({
			destination: { ...destination, lastStatus: null, lastPushAt: null },
		}),
	});
	const result = await runSecrets(
		[
			"external",
			"sync",
			"acme-ci",
			"--env",
			"prod",
			"--path",
			"/web",
			"--remote",
			"WEB_",
			"--interval",
			"2h",
			"--no-project",
		],
		node
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(node.calls[1]?.body ?? "{}")).toEqual({
		storeId: "xs_1",
		environment: "prod",
		path: "/web",
		remotePath: "WEB_",
		intervalSecs: 7200,
	});
	expect(result.out).toContain("xdst_1");
});

test("syncs show each folder's status and push reports the key count", async () => {
	const node = fakeNode({
		"GET /api/vault/external/stores": json({ stores: [store] }),
		"GET /api/vault/external/destinations": json({
			destinations: [destination],
		}),
		"POST /api/vault/external/destinations/xdst_1/push": json({ pushed: 2 }),
	});
	const listed = await runSecrets(["external", "syncs"], node);
	expect(listed.out).toContain("prod:/web");
	expect(listed.out).toContain("acme-ci");
	expect(listed.out).toContain(
		"error: GitHub secret write failed with HTTP 403"
	);
	const pushed = await runSecrets(["external", "push", "xdst_1"], node);
	expect(pushed.code).toBe(0);
	expect(pushed.out).toBe("Pushed 2 keys.\n");
});

test("test exits 1 when the store refuses, and unknown stores or actions are usage errors", async () => {
	const node = fakeNode({
		"GET /api/vault/external/stores": json({ stores: [store] }),
		"POST /api/vault/external/stores/xs_1/test": json({
			ok: false,
			error: "GitHub public key failed with HTTP 401",
		}),
	});
	const refused = await runSecrets(["external", "test", "acme-ci"], node);
	expect(refused.code).toBe(1);
	expect(refused.err).toContain("HTTP 401");
	const missing = await runSecrets(["external", "test", "nope"], node);
	expect(missing.code).not.toBe(0);
	const unknown = await runSecrets(["external", "frobnicate"], node);
	expect(unknown.code).not.toBe(0);
});
