// Unit tests for resolveNodeTarget (core/nodeTarget.ts): which Core node one CLI
// invocation or the TUI talks to. Config and environment are passed explicitly,
// so nothing here reads the real node registry or process env.

import { expect, test } from "bun:test";
import { defaultConfig, type NodesConfig } from "../core/nodes.ts";
import {
	findSavedNode,
	isHttpNodeUrl,
	resolveNodeTarget,
	UnknownNodeError,
} from "../core/nodeTarget.ts";
import { DEFAULT_CORE_URL } from "../core/target.ts";

const config: NodesConfig = {
	default: "prod",
	nodes: [
		{ name: "local", url: DEFAULT_CORE_URL, token: null },
		{ name: "prod", url: "https://prod.example.test/", token: "prod-secret" },
		{ name: "public", url: "https://public.example.test", token: null },
	],
};
const NO_ENV = {};

test("with no --node and no RYU_CORE_URL the saved active node is the target", () => {
	expect(resolveNodeTarget(null, config, NO_ENV)).toEqual({
		url: "https://prod.example.test/",
		token: "prod-secret",
	});
});

test("an unknown active name falls back to the first saved node", () => {
	expect(
		resolveNodeTarget(null, { ...config, default: "ghost" }, NO_ENV).url
	).toBe(DEFAULT_CORE_URL);
});

test("a missing registry lands on this profile's local Core, not the retired :2049", () => {
	// The loopback target also carries its credential-gating transport.
	const target = resolveNodeTarget(null, defaultConfig(), NO_ENV);
	expect({ url: target.url, token: target.token }).toEqual({
		url: DEFAULT_CORE_URL,
		token: null,
	});
});

test("RYU_CORE_URL overrides the active node when --node is absent", () => {
	expect(
		resolveNodeTarget(null, config, {
			RYU_CORE_URL: " http://env-node:7980 ",
			RYU_CORE_TOKEN: " env-secret ",
		})
	).toEqual({ url: "http://env-node:7980", token: "env-secret" });
	expect(resolveNodeTarget(null, config, { RYU_CORE_URL: "   " }).url).toBe(
		"https://prod.example.test/"
	);
});

test("--node <name> resolves the saved node with its own token, over RYU_CORE_URL", () => {
	expect(
		resolveNodeTarget("prod", config, {
			RYU_CORE_URL: "http://env-node:7980",
			RYU_CORE_TOKEN: "env-secret",
		})
	).toEqual({ url: "https://prod.example.test/", token: "prod-secret" });
});

test("--node <url> matches a saved node by URL, ignoring a trailing slash", () => {
	expect(
		resolveNodeTarget("https://prod.example.test", config, NO_ENV).token
	).toBe("prod-secret");
	expect(findSavedNode("https://public.example.test/", config)?.name).toBe(
		"public"
	);
});

test("a name match wins over a URL match", () => {
	const tricky: NodesConfig = {
		default: "a",
		nodes: [
			{ name: "a", url: "http://b", token: "url-match" },
			{ name: "http://b", url: "http://c", token: "name-match" },
		],
	};
	expect(resolveNodeTarget("http://b", tricky, NO_ENV).token).toBe(
		"name-match"
	);
});

test("an unsaved http(s) URL is used as given with the env token", () => {
	expect(
		resolveNodeTarget("http://other.example.test:7980", config, {
			RYU_CORE_TOKEN: "env-secret",
		})
	).toEqual({ url: "http://other.example.test:7980", token: "env-secret" });
});

test("a tokenless saved local Core node falls back to RYU_CORE_TOKEN", () => {
	expect(
		resolveNodeTarget("local", config, { RYU_CORE_TOKEN: "env-secret" }).token
	).toBe("env-secret");
	expect(
		resolveNodeTarget(
			null,
			{ ...config, default: "local" },
			{ RYU_CORE_TOKEN: "env-secret" }
		).token
	).toBe("env-secret");
	expect(resolveNodeTarget("local", config, NO_ENV).token).toBeNull();
});

test("a tokenless remote saved node never receives RYU_CORE_TOKEN", () => {
	const env = { RYU_CORE_TOKEN: "env-secret" };
	// --node by name and by URL.
	expect(resolveNodeTarget("public", config, env).token).toBeNull();
	expect(
		resolveNodeTarget("https://public.example.test/", config, env).token
	).toBeNull();
	// The active-node path (`ryu node use public`).
	expect(
		resolveNodeTarget(null, { ...config, default: "public" }, env)
	).toEqual({ url: "https://public.example.test", token: null });
	// A token paired with a different RYU_CORE_URL does not cross to it either.
	expect(
		resolveNodeTarget("public", config, {
			...env,
			RYU_CORE_URL: "https://a.example.test",
		}).token
	).toBeNull();
});

test("a tokenless saved node at RYU_CORE_URL receives the token paired with it", () => {
	expect(
		resolveNodeTarget("public", config, {
			RYU_CORE_URL: "https://public.example.test/",
			RYU_CORE_TOKEN: "env-secret",
		}).token
	).toBe("env-secret");
});

test("a --node value that is neither a saved node nor an http(s) URL is rejected", () => {
	for (const ref of [
		"staging",
		"ftp://prod.example.test",
		"prod.example.test",
	]) {
		expect(() => resolveNodeTarget(ref, config, NO_ENV)).toThrow(
			UnknownNodeError
		);
	}
	expect(() => resolveNodeTarget("staging", config, NO_ENV)).toThrow(
		"Saved nodes: local, prod, public."
	);
});

test("a blank --node behaves like no --node", () => {
	expect(resolveNodeTarget("  ", config, NO_ENV).url).toBe(
		"https://prod.example.test/"
	);
});

test("isHttpNodeUrl accepts only absolute http(s) URLs", () => {
	expect(isHttpNodeUrl("http://127.0.0.1:7980")).toBe(true);
	expect(isHttpNodeUrl("https://node.example.test")).toBe(true);
	expect(isHttpNodeUrl("prod")).toBe(false);
	expect(isHttpNodeUrl("file:///tmp/x")).toBe(false);
});
