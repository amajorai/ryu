// Wire tests for the item listing, timeline and folder-create clients.

import { afterEach, expect, test } from "bun:test";
import { createVaultFolder } from "./vault-folders.ts";
import { listVaultItemEvents, listVaultItems } from "./vault-items.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function node(reply: unknown) {
	const seen: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push(
				`${request.method} ${url.pathname}${url.search} ${await request.text()}`.trim()
			);
			return Response.json(reply);
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "items-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const ITEM = {
	environment: "prod",
	fieldCount: 3,
	id: "vi_1",
	key: "github login",
	kind: "login",
	path: "/",
	status: "ready" as const,
	updatedAt: 5,
	version: 2,
};

test("items list in one folder of one environment", async () => {
	const list = node({ items: [ITEM] });
	expect(
		await listVaultItems(list.target, { environment: "prod", path: "/" })
	).toEqual([ITEM]);
	expect(list.seen).toEqual(["GET /api/vault/items?environment=prod&path=%2F"]);
});

test("the timeline pages after a cursor and returns the next one", async () => {
	const events = node({
		events: [
			{
				actorKind: "user",
				actorId: "ada",
				createdAt: 4,
				data: { fieldsSet: ["password"] },
				itemId: "vi_1",
				name: "updated",
				seq: 7,
				version: 2,
			},
		],
		next: 7,
	});
	const page = await listVaultItemEvents(events.target, "github login", {
		environment: "prod",
		after: 3,
		limit: 50,
	});
	expect(page.next).toBe(7);
	expect(page.events[0]?.name).toBe("updated");
	expect(events.seen).toEqual([
		"GET /api/vault/items/github%20login/events?environment=prod&after=3&limit=50",
	]);
});

test("a folder is created in the environment and Core's path comes back", async () => {
	const created = node({ ok: true, path: "/api/keys" });
	expect(
		await createVaultFolder(created.target, {
			environment: "prod",
			path: "api/keys",
		})
	).toBe("/api/keys");
	expect(created.seen).toEqual([
		'POST /api/vault/folders {"environment":"prod","path":"api/keys"}',
	]);
});
