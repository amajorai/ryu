import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	applySafeMode,
	fetchSafeMode,
	type SafeModeState,
	setSafeMode,
} from "./safe-mode.ts";
import {
	safeModeSentinelSchema,
	safeModeWireSchema,
} from "./safe-mode-wire-contracts.ts";

let reply = Response.json({});
const requests: { body: string; method: string; path: string }[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		requests.push({
			body: await request.text(),
			method: request.method,
			path: new URL(request.url).pathname,
		});
		return reply.clone();
	},
});
const target = {
	url: String(server.url).replace(/\/$/, ""),
	token: "safe-mode-node",
	userJwt: "safe-mode-user",
};
beforeEach(() => {
	requests.length = 0;
});
afterAll(() => {
	server.stop(true);
});
const emptyState = {
	enabled: false,
	preferenceEnabled: false,
	source: "off",
	suppressed: { kernelPlugins: 0, mcpServers: 0, plugins: 0, skills: 0 },
	userClearable: true,
} satisfies SafeModeState;
test("older safe-mode fields keep defaults and future source strings use the established fallback", async () => {
	for (const raw of [
		null,
		{},
		{
			enabled: null,
			preference_enabled: null,
			source: null,
			suppressed: null,
			user_clearable: null,
		},
		{ source: "future-mode" },
	]) {
		reply = Response.json(raw);
		expect(await fetchSafeMode(target)).toEqual(emptyState);
	}
	reply = Response.json({
		enabled: true,
		preference_enabled: false,
		source: "env",
		user_clearable: false,
		suppressed: { kernel_plugins: 2, mcp_servers: 3, plugins: 4, skills: 5 },
	});
	expect(await fetchSafeMode(target)).toEqual({
		enabled: true,
		preferenceEnabled: false,
		source: "env",
		suppressed: { kernelPlugins: 2, mcpServers: 3, plugins: 4, skills: 5 },
		userClearable: false,
	});
});
test("safe-mode owner validates every flag/count and the native sentinel boolean", () => {
	for (const invalid of [
		{ enabled: "true" },
		{ preference_enabled: 1 },
		{ user_clearable: "false" },
		{ suppressed: { plugins: "4" } },
		{ suppressed: { skills: Number.POSITIVE_INFINITY } },
	]) {
		expect(safeModeWireSchema.safeParse(invalid).success).toBe(false);
	}
	for (const valid of [true, false]) {
		expect(safeModeSentinelSchema.parse(valid)).toBe(valid);
	}
	for (const invalid of [0, 1, null, undefined, "true", {}]) {
		expect(safeModeSentinelSchema.safeParse(invalid).success).toBe(false);
	}
});
test("Safe Mode mutations preserve next-boot request bytes and Core refusals", async () => {
	reply = Response.json({ restart_required: true });
	await setSafeMode(target, false);
	expect(requests[0]).toEqual({
		body: '{"enabled":false}',
		method: "PUT",
		path: "/api/safe-mode",
	});
	expect(await applySafeMode(target, true)).toBe("core");
	reply = Response.json({ error: "forced by environment" }, { status: 409 });
	await expect(applySafeMode(target, false)).rejects.toThrow(
		"forced by environment"
	);
	expect(requests).toHaveLength(3);
});
