// Wire tests for broker service writes and the catalog: create from a full
// definition or a template, replace under the path name, delete, and the
// environment filter on the list.

import { afterEach, expect, test } from "bun:test";
import {
	createVaultBrokerService,
	deleteVaultBrokerService,
	listVaultBrokerCatalog,
	listVaultBrokerServices,
	updateVaultBrokerService,
	type VaultBrokerServiceInput,
} from "./vault-broker.ts";

interface Seen {
	body: string;
	method: string;
	target: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function node(reply: unknown, status = 200) {
	const seen: Seen[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push({
				body: await request.text(),
				method: request.method,
				target: `${url.pathname}${url.search}`,
			});
			return Response.json(reply, { status });
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "services-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const INPUT: VaultBrokerServiceInput = {
	auth: { token: "secret:GITHUB_TOKEN", type: "bearer" },
	enabled: true,
	environment: "prod",
	host: "api.github.com",
	name: "github",
	pathPrefix: "/",
};

const STORED = {
	...INPUT,
	createdAt: "2026-10-01T00:00:00+00:00",
	updatedAt: "2026-10-01T00:00:00+00:00",
};

test("the list filters by environment only when one is given", async () => {
	const { seen, target } = node({ services: [STORED] });
	expect(await listVaultBrokerServices(target, "prod")).toEqual([STORED]);
	await listVaultBrokerServices(target);
	expect(seen.map((row) => row.target)).toEqual([
		"/api/vault/broker/services?environment=prod",
		"/api/vault/broker/services",
	]);
});

test("create posts a definition or a template body as given", async () => {
	const { seen, target } = node({ service: STORED });
	expect(await createVaultBrokerService(target, INPUT)).toEqual(STORED);
	await createVaultBrokerService(target, {
		credentialRef: "secret:GH",
		environment: "prod",
		template: "github",
	});
	expect(seen.map((row) => [row.method, row.target])).toEqual([
		["POST", "/api/vault/broker/services"],
		["POST", "/api/vault/broker/services"],
	]);
	expect(JSON.parse(seen[0]?.body ?? "")).toEqual(INPUT);
	expect(JSON.parse(seen[1]?.body ?? "")).toEqual({
		credentialRef: "secret:GH",
		environment: "prod",
		template: "github",
	});
});

test("replace puts to the encoded path name, which wins over the body's name", async () => {
	const { seen, target } = node({ service: STORED });
	await updateVaultBrokerService(target, "git hub", { ...INPUT, name: "x" });
	expect(seen[0]).toMatchObject({
		method: "PUT",
		target: "/api/vault/broker/services/git%20hub",
	});
	expect(JSON.parse(seen[0]?.body ?? "").name).toBe("git hub");
});

test("delete reports whether a service existed", async () => {
	const { seen, target } = node({ deleted: false });
	expect(await deleteVaultBrokerService(target, "github")).toBe(false);
	expect(seen[0]).toMatchObject({
		method: "DELETE",
		target: "/api/vault/broker/services/github",
	});
});

test("the catalog lists templates and refuses one with an unknown auth type", async () => {
	const template = {
		auth: { header: "x-api-key", type: "api_key" as const, value: "secret:K" },
		host: "api.anthropic.com",
		id: "anthropic",
		name: "Anthropic",
		pathPrefix: "/",
		suggestedRef: "secret:K",
	};
	const ok = node({ templates: [template] });
	expect(await listVaultBrokerCatalog(ok.target)).toEqual([template]);
	expect(ok.seen[0]?.target).toBe("/api/vault/broker/catalog");

	const bad = node({
		templates: [{ ...template, auth: { type: "kerberos" } }],
	});
	await expect(listVaultBrokerCatalog(bad.target)).rejects.toThrow();
});

test("a refused write surfaces Core's status", async () => {
	const { target } = node(
		{ error: "vault_denied: the `admin` capability is required" },
		403
	);
	await expect(createVaultBrokerService(target, INPUT)).rejects.toMatchObject({
		status: 403,
	});
});
