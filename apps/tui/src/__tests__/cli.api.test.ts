// Tests for the real CoreApi HTTP layer's security guard: `execAppCommand` must
// REFUSE a path-traversal command path before it ever builds a URL and calls
// fetch. Without this, a `..`/`%2e`/`\` path is normalized by the URL parser to
// escape `/api/ext/<id>/` and hit an arbitrary internal Core/Gateway route with
// the full node bearer (the reported sandbox-escape). The other CoreApi methods
// are covered via the mockable seam in cli.dispatch.test.ts.

import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { realCoreApi } from "../cli/api.ts";

const target: ApiTarget = { url: "http://node:7980", token: "node-secret" };
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

test("execAppCommand refuses a traversal path without calling fetch", async () => {
	let fetchCalled = false;
	globalThis.fetch = (() => {
		fetchCalled = true;
		return Promise.reject(new Error("fetch must not be called"));
	}) as unknown as typeof fetch;

	for (const path of [
		"/../../../v1/chat/completions",
		"/../api/plugins/com.ryu.mail/uninstall",
		"/%2e%2e/%2e%2e/v1",
		"/..\\..\\v1",
	]) {
		const res = await realCoreApi.execAppCommand(
			target,
			"com.evil.app",
			{ method: "POST", path },
			[]
		);
		expect(res.status).toBe(400);
		expect(res.body).toContain("unsafe path");
	}
	expect(fetchCalled).toBe(false);
});

test("execAppCommand issues the request for a safe path", async () => {
	let calledUrl = "";
	globalThis.fetch = ((url: string | URL) => {
		calledUrl = String(url);
		return Promise.resolve(new Response("ok", { status: 200 }));
	}) as unknown as typeof fetch;

	const res = await realCoreApi.execAppCommand(
		target,
		"mail",
		{ method: "GET", path: "/status" },
		[]
	);
	expect(res.status).toBe(200);
	expect(res.body).toBe("ok");
	expect(calledUrl).toBe(
		"http://node:7980/api/ext/mail/status?args=%5B%5D"
	);
});
