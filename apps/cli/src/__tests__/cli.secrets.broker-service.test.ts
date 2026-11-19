// `ryu-cli secrets broker service show|apply|add|delete`: YAML and JSON
// definitions round-trip, apply creates or replaces by name, dry runs write
// nothing, and malformed files are refused before Core is called. Core is
// faked through the target's `fetch`; files live in a temporary directory.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDefinitions } from "../cli/secrets-broker-service.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const SERVICE = {
	auth: { credentialRef: "OPENAI_API_KEY", type: "bearer" },
	createdAt: "2026-01-01T00:00:00Z",
	enabled: true,
	environment: "dev",
	host: "api.openai.com",
	name: "openai",
	pathPrefix: "/",
	updatedAt: "2026-01-02T00:00:00Z",
};

let dir: string | null = null;
afterEach(async () => {
	if (dir) {
		await rm(dir, { force: true, recursive: true });
		dir = null;
	}
});

async function fileWith(name: string, text: string): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "ryu-broker-service-"));
	await writeFile(join(dir, name), text);
	return dir;
}

test("show prints an editable YAML definition without server timestamps", async () => {
	const node = fakeNode({
		"GET /api/vault/broker/services/openai": json({ service: SERVICE }),
	});
	const result = await runSecrets(
		["broker", "service", "show", "openai"],
		node
	);
	expect(result.code).toBe(0);
	const shown = Bun.YAML.parse(result.out) as Record<string, unknown>;
	expect(shown.name).toBe("openai");
	expect(shown.auth).toEqual(SERVICE.auth);
	expect(shown).not.toHaveProperty("createdAt");
	expect(shown).not.toHaveProperty("updatedAt");

	const asJson = await runSecrets(
		["broker", "service", "show", "openai", "--format", "json"],
		node
	);
	expect(JSON.parse(asJson.out).host).toBe("api.openai.com");
	const bad = await runSecrets(
		["broker", "service", "show", "openai", "--format", "toml"],
		node
	);
	expect(bad.code).toBe(2);
});

test("apply updates existing services by name and creates new ones", async () => {
	const cwd = await fileWith(
		"services.yaml",
		[
			"services:",
			"  - name: openai",
			"    environment: dev",
			"    host: api.openai.com",
			"    auth: { type: bearer, credentialRef: OPENAI_API_KEY }",
			"    createdAt: 2020-01-01T00:00:00Z",
			"  - name: github",
			"    environment: dev",
			"    host: api.github.com",
			"    auth: { type: bearer, credentialRef: GITHUB_TOKEN }",
			"",
		].join("\n")
	);
	const node = fakeNode({
		"GET /api/vault/broker/services": json({ services: [SERVICE] }),
		"PUT /api/vault/broker/services/openai": json({ service: SERVICE }),
		"POST /api/vault/broker/services": json({
			service: { ...SERVICE, host: "api.github.com", name: "github" },
		}),
	});
	const result = await runSecrets(
		["broker", "service", "apply", "services.yaml"],
		node,
		{ cwd }
	);
	expect(result.code).toBe(0);
	expect(result.out).toContain("Updated broker service openai.");
	expect(result.out).toContain("Created broker service github.");
	const put = node.calls.find((call) => call.route.startsWith("PUT"));
	const body = JSON.parse(put?.body ?? "{}");
	expect(body.auth).toEqual({
		credentialRef: "OPENAI_API_KEY",
		type: "bearer",
	});
	expect(body).not.toHaveProperty("createdAt");
	const post = node.calls.find((call) => call.route.startsWith("POST"));
	expect(JSON.parse(post?.body ?? "{}").name).toBe("github");
});

test("apply --dry-run reports and writes nothing; a JSON file works too", async () => {
	const cwd = await fileWith(
		"svc.json",
		JSON.stringify({ environment: "dev", host: "x.test", name: "new-svc" })
	);
	const node = fakeNode({
		"GET /api/vault/broker/services": json({ services: [SERVICE] }),
	});
	const result = await runSecrets(
		["broker", "service", "apply", "svc.json", "--dry-run"],
		node,
		{ cwd }
	);
	expect(result.code).toBe(0);
	expect(result.out).toContain("Would create broker service new-svc.");
	expect(node.calls.map((call) => call.route)).toEqual([
		"GET /api/vault/broker/services",
	]);
});

test("malformed definitions are refused before Core is called", () => {
	expect(() => parseDefinitions("name: [unclosed", "f.yaml")).toThrow(
		"not valid YAML or JSON"
	);
	expect(() => parseDefinitions("[]", "f.yaml")).toThrow("no broker services");
	expect(() => parseDefinitions("- 3", "f.yaml")).toThrow(
		"not a service definition"
	);
	expect(() => parseDefinitions("host: x.test", "f.yaml")).toThrow(
		"needs a valid name"
	);
	expect(() => parseDefinitions("- name: a\n- name: a\n", "f.yaml")).toThrow(
		"more than once"
	);
	expect(parseDefinitions("name: a\nupdatedAt: x\n", "f.yaml")).toEqual([
		{ name: "a" },
	]);
});

test("add creates from a catalog template, delete reports a missing service", async () => {
	const node = fakeNode({
		"POST /api/vault/broker/services": json({ service: SERVICE }),
		"DELETE /api/vault/broker/services/gone": json({ deleted: false }),
		"DELETE /api/vault/broker/services/openai": json({ deleted: true }),
	});
	const added = await runSecrets(
		[
			"broker",
			"service",
			"add",
			"--template",
			"openai",
			"--env",
			"dev",
			"--credential-ref",
			"OPENAI_API_KEY",
		],
		node
	);
	expect(added.code).toBe(0);
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
		credentialRef: "OPENAI_API_KEY",
		environment: "dev",
		template: "openai",
	});
	const gone = await runSecrets(["broker", "service", "delete", "gone"], node);
	expect(gone.code).toBe(1);
	expect(gone.out).toContain("No broker service named gone.");
	const deleted = await runSecrets(
		["broker", "service", "delete", "openai"],
		node
	);
	expect(deleted.code).toBe(0);
});
