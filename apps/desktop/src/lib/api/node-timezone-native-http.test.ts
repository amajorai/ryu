import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { z } from "zod";
import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";
import {
	getNodeTimeZone,
	NodeTimeZoneError,
	nodeTimeZonePatchSchema,
	nodeTimeZoneServerSchema,
	setNodeTimeZone,
} from "./node-timezone.ts";

const nativeFetch = globalThis.fetch;
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const ownsBrowserGlobals = !Reflect.has(globalThis, "window");
if (ownsBrowserGlobals) {
	GlobalRegistrator.register();
}
const storage = globalThis.localStorage;
const requests: {
	authorization: string | null;
	body: string;
	contentType: string | null;
	method: string;
	path: string;
}[] = [];
const observedOrigins: string[] = [];
const reply = { body: "{}", status: 200 };
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		requests.push({
			authorization: request.headers.get("Authorization"),
			body: await request.text(),
			contentType: request.headers.get("Content-Type"),
			method: request.method,
			path: new URL(request.url).pathname,
		});
		return new NativeResponse(reply.body, {
			headers: { "content-type": "application/json" },
			status: reply.status,
		});
	},
});
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
	Object.assign(
		async (
			input: Parameters<typeof nativeFetch>[0],
			init?: Parameters<typeof nativeFetch>[1]
		) => {
			const request = new NativeRequest(input, init);
			const url = new URL(request.url);
			observedOrigins.push(url.origin);
			return nativeFetch(
				new NativeRequest(
					`http://127.0.0.1:${server.port}${url.pathname}${url.search}`,
					request
				)
			);
		},
		{ preconnect: nativeFetch.preconnect }
	)
);
afterAll(() => {
	fetchSpy.mockRestore();
	server.stop(true);
	if (ownsBrowserGlobals) {
		GlobalRegistrator.unregister();
	}
});
const fullServer = {
	archived: false,
	backupsEnabled: false,
	createdAt: "2026-10-07T00:00:00.000Z",
	createdBy: "native-user",
	desktopEnabled: false,
	detectedTimeZone: "Europe/Berlin",
	effectiveTimeZone: "Europe/Berlin",
	error: null,
	hetznerServerId: null,
	hetznerType: "cx23",
	id: "native-server",
	includedWithMax: false,
	includedWithPlan: false,
	inferenceMode: "managed",
	location: "nbg1",
	monthlyUsdSnapshot: 0,
	organizationId: "native-org",
	polarSubscriptionId: null,
	publicUrl: null,
	removeGraceEndsAt: null,
	removeScheduledAt: null,
	status: "active",
	timeZone: null,
	updatedAt: "2026-10-07T00:00:00.000Z",
} satisfies z.output<typeof nodeTimeZoneServerSchema>;
test("GET admits full native server fields with retained future metadata", async () => {
	storage.setItem(TOKEN_KEY, "native-session");
	const raw = { ...fullServer, future: { retained: ["雪", null] } };
	reply.body = JSON.stringify(raw);
	expect(nodeTimeZoneServerSchema.parse(raw)).toBe(raw);
	expect(await getNodeTimeZone("native-org", "native-server")).toEqual(raw);
	expect(observedOrigins.at(-1)).toBe(new URL(BACKEND_URL).origin);
	expect(requests.at(-1)).toEqual({
		authorization: "Bearer native-session",
		body: "",
		contentType: null,
		method: "GET",
		path: "/api/servers/orgs/native-org/servers/native-server",
	});
});
test("PATCH retains explicit timezone and null-clear request bytes", async () => {
	for (const timeZone of ["Asia/Tokyo", null]) {
		const raw = {
			id: "native-server",
			detectedTimeZone: "Europe/Berlin",
			effectiveTimeZone: timeZone ?? "Europe/Berlin",
			nextQuietWindow: "2026-10-08T01:00:00.000Z",
			timeZone,
		};
		reply.body = JSON.stringify(raw);
		expect(nodeTimeZonePatchSchema.parse(raw)).toBe(raw);
		expect(
			await setNodeTimeZone("native-org", "native-server", timeZone)
		).toEqual(raw);
		expect(observedOrigins.at(-1)).toBe(new URL(BACKEND_URL).origin);
		expect(requests.at(-1)).toEqual({
			authorization: "Bearer native-session",
			body: JSON.stringify({ timeZone }),
			contentType: "application/json",
			method: "PATCH",
			path: "/api/servers/orgs/native-org/servers/native-server/timezone",
		});
	}
});
test("missing session refuses HTTP and native error coercion/status survive", async () => {
	storage.removeItem(TOKEN_KEY);
	const count = requests.length;
	await expect(getNodeTimeZone("org", "server")).rejects.toThrow(
		"Sign in to manage this node."
	);
	expect(requests.length).toBe(count);
	storage.setItem(TOKEN_KEY, "native-session");
	for (const fixture of [
		{
			body: '{"message":"requires admin role"}',
			message: "requires admin role",
		},
		{ body: '{"message":null}', message: "Request failed: 403" },
		{ body: '{"message":42}', message: "42" },
		{ body: "not-json", message: "Request failed: 403" },
	]) {
		reply.status = 403;
		reply.body = fixture.body;
		try {
			await getNodeTimeZone("org", "server");
			throw new Error("Expected refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(NodeTimeZoneError);
			if (!(error instanceof NodeTimeZoneError)) {
				throw error;
			}
			expect(error.status).toBe(403);
			expect(error.message).toBe(fixture.message);
			expect(observedOrigins.at(-1)).toBe(new URL(BACKEND_URL).origin);
		}
	}
});
test("malformed success and interchanged GET/PATCH publishers are rejected", async () => {
	reply.status = 200;
	for (const value of [
		null,
		[],
		{ ...fullServer, effectiveTimeZone: 42 },
		{
			id: "server",
			timeZone: null,
			detectedTimeZone: null,
			effectiveTimeZone: "UTC",
			nextQuietWindow: "2026-10-08T03:00:00.000Z",
		},
	]) {
		reply.body = JSON.stringify(value);
		await expect(getNodeTimeZone("org", "server")).rejects.toThrow();
		expect(observedOrigins.at(-1)).toBe(new URL(BACKEND_URL).origin);
	}
	reply.body = JSON.stringify(fullServer);
	await expect(setNodeTimeZone("org", "server", null)).rejects.toThrow();
	expect(observedOrigins.at(-1)).toBe(new URL(BACKEND_URL).origin);
});
