import { expect, it } from "bun:test";
import { type ActivityItem, createActivity, listActivity } from "./activity.ts";

const item = {
	id: "row",
	kind: "note",
	source: "manual",
	title: "Note",
	body: null,
	agent_id: null,
	session_id: null,
	level: "info",
	metadata: null,
	created_at: 1,
} satisfies ActivityItem;
it("forwards selected-node activity queries and complete native metadata writes", async () => {
	const received: {
		url: string;
		method: string;
		body: string;
		authorization: string | null;
	}[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			received.push({
				url: new URL(request.url).pathname + new URL(request.url).search,
				method: request.method,
				body: await request.text(),
				authorization: request.headers.get("Authorization"),
			});
			return Response.json(
				request.method === "POST" ? { item } : { items: [item] }
			);
		},
	});
	try {
		const target = { url: server.url.toString(), token: null };
		expect(await listActivity(target, { limit: 12, before: 4 })).toEqual([
			item,
		]);
		for (const metadata of [
			null,
			"scalar",
			[true, null],
			JSON.parse('{"__proto__":{"future":true}}'),
		]) {
			expect(
				await createActivity(target, { kind: "note", title: "Note", metadata })
			).toEqual(item);
		}
		expect(received[0]).toEqual({
			url: "/api/activity?limit=12&before=4",
			method: "GET",
			body: "",
			authorization: null,
		});
		expect(received.slice(1).map((entry) => entry.body)).toEqual([
			'{"kind":"note","title":"Note","metadata":null}',
			'{"kind":"note","title":"Note","metadata":"scalar"}',
			'{"kind":"note","title":"Note","metadata":[true,null]}',
			'{"kind":"note","title":"Note","metadata":{"__proto__":{"future":true}}}',
		]);
		await createActivity(target, {
			kind: "note",
			title: "Note",
			metadata: { omitted: undefined, overflow: Number.POSITIVE_INFINITY },
		});
		expect(received.at(-1)?.body).toBe(
			'{"kind":"note","title":"Note","metadata":{"overflow":null}}'
		);
	} finally {
		await server.stop(true);
	}
});
it("keeps native empty-list and create-error fallbacks while rejecting falsely typed successful items", async () => {
	let reply = "{}";
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response(reply, {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	try {
		const target = { url: server.url.toString(), token: null };
		expect(await listActivity(target)).toEqual([]);
		reply = '{"items":null}';
		expect(await listActivity(target)).toEqual([]);
		reply = '{"error":"database offline"}';
		await expect(
			createActivity(target, { kind: "note", title: "Note" })
		).rejects.toThrow("database offline");
		reply = "{}";
		await expect(
			createActivity(target, { kind: "note", title: "Note" })
		).rejects.toThrow("failed to create activity item");
		reply = '{"items":[{"id":"partial"}]}';
		await expect(listActivity(target)).rejects.toThrow();
		reply = '{"item":{"id":"partial"}}';
		await expect(
			createActivity(target, { kind: "note", title: "Note" })
		).rejects.toThrow();
	} finally {
		await server.stop(true);
	}
});
