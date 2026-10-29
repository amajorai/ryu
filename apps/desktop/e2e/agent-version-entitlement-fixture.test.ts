import { expect, test } from "bun:test";
import { createVersionEntitlementPreferences } from "./agent-version-entitlement-fixture.ts";
test("real HTTP exact boot-sync preference writes round-trip false independently from desktop access and sibling authority; invalid mutation preserves both choices", async () => {
	const fixture = createVersionEntitlementPreferences();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			const match = /^\/(a|b)(\/api\/preferences\/[^/?]+)$/.exec(url.pathname);
			if (!match || url.search)
				return Response.json(
					{ error: "Unknown fixture route" },
					{ status: 503 },
				);
			const scope = match[1] as "a" | "b";
			if (
				request.headers.get("authorization") !==
					`Bearer version-bearer-${scope}` ||
				request.headers.get("x-ryu-user-jwt") !== `version-user-${scope}`
			)
				return Response.json({ error: "Wrong authority" }, { status: 403 });
			const body = request.body ? await request.json() : null;
			const result = fixture.handle(scope, request.method, match[2]!, body);
			return Response.json(
				result?.body ?? { error: "Unknown fixture method" },
				{ status: result?.status ?? 503 },
			);
		},
	});
	const url = server.url.toString().replace(/\/$/, "");
	const send = (scope: string, key: string, method = "GET", value?: unknown) =>
		fetch(`${url}/${scope}/api/preferences/${key}`, {
			method,
			headers: {
				authorization: `Bearer version-bearer-${scope}`,
				"x-ryu-user-jwt": `version-user-${scope}`,
				"content-type": "application/json",
			},
			body: method === "PUT" ? JSON.stringify(value) : undefined,
		});
	try {
		expect(
			(await send("a", "entitlement-active", "PUT", { value: "true" })).status,
		).toBe(200);
		expect(
			(await send("a", "managed-inference-entitled", "PUT", { value: "false" }))
				.status,
		).toBe(200);
		expect(
			await (await send("a", "managed-inference-entitled")).json(),
		).toEqual({ key: "managed-inference-entitled", value: "false" });
		expect(await (await send("a", "entitlement-active")).json()).toEqual({
			key: "entitlement-active",
			value: "true",
		});
		expect(
			await (await send("b", "managed-inference-entitled")).json(),
		).toEqual({ key: "managed-inference-entitled", value: null });
		expect(
			(await send("a", "managed-inference-entitled", "PUT", { value: false }))
				.status,
		).toBe(400);
		expect(
			(
				await send("a", "managed-inference-entitled", "PUT", {
					value: "false",
					extra: true,
				})
			).status,
		).toBe(400);
		expect(
			(await send("a", "unrelated-preference", "PUT", { value: "false" }))
				.status,
		).toBe(503);
		expect(
			await (await send("a", "managed-inference-entitled")).json(),
		).toEqual({ key: "managed-inference-entitled", value: "false" });
		expect(fixture.snapshot("entitlement-active")).toEqual({
			a: "true",
			b: null,
		});
	} finally {
		server.stop(true);
	}
});
