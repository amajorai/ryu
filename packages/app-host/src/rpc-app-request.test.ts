import { describe, expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import {
	asAppRequestArg,
	capabilitiesFromGrants,
	dispatchRpc,
	type HostServices,
} from "./rpc.ts";

const services = (appRequest: HostServices["appRequest"]): HostServices => ({
	appRequest,
	listAgents: () => Promise.resolve([]),
	registerRoute: (claim: RouteClaim) => Promise.resolve({ path: claim.path }),
});

describe("asAppRequestArg", () => {
	test("normalizes a relative path and preserves a valid request", () => {
		expect(
			asAppRequestArg({
				body: { message: "hello" },
				method: "POST",
				path: "/pulls/openai/codex/42/comment?notify=true",
			})
		).toEqual({
			body: { message: "hello" },
			method: "POST",
			path: "/pulls/openai/codex/42/comment?notify=true",
		});
	});

	test("rejects host selection, traversal, backslashes, and unknown methods", () => {
		expect(asAppRequestArg({ path: "https://evil.test/x" })).toBeNull();
		expect(asAppRequestArg({ path: "//evil.test/x" })).toBeNull();
		expect(asAppRequestArg({ path: "/%2e%2e/settings" })).toBeNull();
		expect(asAppRequestArg({ path: "/..\\settings" })).toBeNull();
		expect(asAppRequestArg({ method: "CONNECT", path: "/status" })).toBeNull();
	});

	test("dispatches only with the Gateway-approved app:http grant", async () => {
		const appRequest: HostServices["appRequest"] = async (input) => ({ input });
		const input = { method: "GET", path: "/status" };
		const args = [input];
		await expect(
			dispatchRpc(
				"app.request",
				args,
				capabilitiesFromGrants(["app:http"]),
				services(appRequest)
			)
		).resolves.toEqual({ input });
		await expect(
			dispatchRpc("app.request", args, new Set(), services(appRequest))
		).rejects.toMatchObject({ code: "denied" });
	});
});

test("only own-app reads receive the host document lifetime", async () => {
	const controller = new AbortController();
	const signals: (AbortSignal | undefined)[] = [];
	const host = services(async (_input, signal) => {
		signals.push(signal);
		return null;
	});
	const grants = capabilitiesFromGrants(["app:http"]);
	for (const method of [undefined, "GET", "POST", "PUT", "PATCH", "DELETE"]) {
		await dispatchRpc(
			"app.request",
			[{ path: "/status", method }],
			grants,
			host,
			controller.signal
		);
	}
	expect(signals).toEqual([
		controller.signal,
		controller.signal,
		undefined,
		undefined,
		undefined,
		undefined,
	]);
	controller.abort();
	await expect(
		dispatchRpc(
			"app.request",
			[{ path: "/status" }],
			grants,
			host,
			controller.signal
		)
	).rejects.toThrow();
	expect(signals).toHaveLength(6);
});
