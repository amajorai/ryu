import { expect, test } from "bun:test";
import { makeHeaders } from "@/src/lib/api/client.ts";
import { createUgcCall, readUgcError } from "./ugc-request.ts";

test("retains sidecar error priority and native Error conversion of JSON diagnostics", () => {
	for (const [body, selected] of [
		['{"error":"error","message":"message"}', "error"],
		['{"error":null,"message":"message"}', "message"],
		['{"error":false,"message":"message"}', false],
		['{"error":0,"message":"message"}', 0],
		["  text  ", "text"],
		["", "Request failed (409)"],
		["null", "null"],
	] as const) {
		expect(readUgcError(body, 409)).toEqual(selected);
	}
	expect(
		new Error(String(readUgcError('{"error":{"code":"future"}}', 409))).message
	).toBe("[object Object]");
	expect(
		() => new Error(String(readUgcError('{"error":{"toString":null}}', 409)))
	).toThrow(TypeError);
});

test("uses the selected Core public mount with unchanged native credentials, request overrides and no-content reply", async () => {
	const requests: {
		pathname: string;
		body: string;
		authorization: string | null;
		identity: string | null;
	}[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const pathname = new URL(request.url).pathname;
			requests.push({
				pathname,
				body: await request.text(),
				authorization: request.headers.get("authorization"),
				identity: request.headers.get("x-ryu-user-jwt"),
			});
			if (pathname.endsWith("/empty")) {
				return new Response(null, { status: 204 });
			}
			if (pathname.endsWith("/failed")) {
				return Response.json(
					{ error: { code: "future" }, message: "secondary" },
					{ status: 409 }
				);
			}
			return new Response('{"__proto__":{"number":1e400},"created":true}', {
				headers: { "content-type": "application/json" },
			});
		},
	});
	try {
		const call = createUgcCall(
			{
				url: server.url.toString(),
				token: "node-bearer",
				userJwt: "delegation",
			},
			makeHeaders("node-bearer", "delegation")
		);
		const body = '{"decision":"reject","reason":"operator"}';
		const reply = await call("/submissions/post/review", {
			method: "POST",
			body,
		});
		expect(Object.getOwnPropertyDescriptor(reply, "__proto__")?.value).toEqual({
			number: Number.POSITIVE_INFINITY,
		});
		expect(await call("/empty")).toEqual({});
		await expect(call("/failed")).rejects.toThrow("[object Object]");
		await call("/override", { headers: { authorization: "Bearer override" } });
		expect(requests).toEqual([
			{
				pathname: "/api/ugc/submissions/post/review",
				body,
				authorization: "Bearer node-bearer",
				identity: "delegation",
			},
			{
				pathname: "/api/ugc/empty",
				body: "",
				authorization: "Bearer node-bearer",
				identity: "delegation",
			},
			{
				pathname: "/api/ugc/failed",
				body: "",
				authorization: "Bearer node-bearer",
				identity: "delegation",
			},
			{
				pathname: "/api/ugc/override",
				body: "",
				authorization: "Bearer override",
				identity: null,
			},
		]);
	} finally {
		server.stop(true);
	}
});
