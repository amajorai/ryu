// packages/core-client/src/pure-helpers.test.ts
//
// Pure-logic unit tests for the small deterministic helpers scattered across the
// core-client domain modules: version bumping, engine classification, download
// lifecycle predicates, mesh-status normalization, ACP option flattening,
// dependency-error rendering, gateway-key generation, and the chat/voice URL +
// header builders. No network — every function here is side-effect-free.

import { describe, expect, test } from "bun:test";
import { type AcpConfigOption, flattenConfigOptions } from "./acp.ts";
import { bumpPatchVersion } from "./agents.ts";
import {
	answerNowChat,
	cancelChat,
	chatHeaders,
	chatStreamResumeUrl,
	chatStreamUrl,
	fetchNextPromptSuggestions,
} from "./chat.ts";
import type { ApiTarget } from "./client.ts";
import { isInFlight, isTerminal } from "./downloads.ts";
import { generateGatewayKey } from "./gateway.ts";
import { isLocalEngine } from "./inference.ts";
import { normalizeMeshStatus } from "./mesh.ts";
import { type DependencyError, describeDependencyError } from "./plugins.ts";
import { updateCheckFailed } from "./updates.ts";
import { voiceWsUrl } from "./voice-session.ts";

const target = (over?: Partial<ApiTarget>): ApiTarget => ({
	url: "http://127.0.0.1:7980",
	token: null,
	...over,
	userJwt: null,
});

describe("bumpPatchVersion", () => {
	test("increments the patch component", () => {
		expect(bumpPatchVersion("1.0.0")).toBe("1.0.1");
		expect(bumpPatchVersion("2.5.9")).toBe("2.5.10");
	});

	test("returns the original for a malformed or non-numeric version", () => {
		expect(bumpPatchVersion("1.0")).toBe("1.0");
		expect(bumpPatchVersion("abc")).toBe("abc");
		expect(bumpPatchVersion("1.0.x")).toBe("1.0.x");
		expect(bumpPatchVersion("")).toBe("");
	});
});

describe("updateCheckFailed", () => {
	test("keeps a transport error distinct from a clean no-update verdict", () => {
		const base = {
			asset: null,
			channel: "stable",
			current: "0.1.15",
			html_url: null,
			latest: "0.1.15",
			notes: null,
			update_available: false,
		};

		expect(updateCheckFailed(base)).toBe(false);
		expect(updateCheckFailed({ ...base, error: "Core unavailable" })).toBe(
			true
		);
		expect(updateCheckFailed({ ...base, latest: "" })).toBe(true);
	});
});

describe("isLocalEngine", () => {
	test("recognizes the known local engines case-insensitively", () => {
		for (const e of ["llamacpp", "OLLAMA", " vllm ", "SgLang"]) {
			expect(isLocalEngine(e)).toBe(true);
		}
	});

	test("strips the acp: prefix case-insensitively", () => {
		// Regression: the strip once ran BEFORE toLowerCase, so `ACP:llamacpp`
		// and `acp:llamacpp` disagreed. Both casings must agree.
		expect(isLocalEngine("acp:llamacpp")).toBe(true);
		expect(isLocalEngine("ACP:llamacpp")).toBe(true);
	});

	test("returns false for unknown, empty, null, and undefined", () => {
		expect(isLocalEngine("openai")).toBe(false);
		expect(isLocalEngine("")).toBe(false);
		expect(isLocalEngine(null)).toBe(false);
		expect(isLocalEngine(undefined)).toBe(false);
	});
});

describe("download state predicates", () => {
	test("isTerminal is true only for completed/cancelled/failed", () => {
		expect(isTerminal("completed")).toBe(true);
		expect(isTerminal("cancelled")).toBe(true);
		expect(isTerminal("failed")).toBe(true);
		for (const s of ["queued", "active", "paused", "verifying"] as const) {
			expect(isTerminal(s)).toBe(false);
		}
	});

	test("isInFlight is true only for queued/active/verifying", () => {
		expect(isInFlight("queued")).toBe(true);
		expect(isInFlight("active")).toBe(true);
		expect(isInFlight("verifying")).toBe(true);
		for (const s of ["paused", "completed", "cancelled", "failed"] as const) {
			expect(isInFlight(s)).toBe(false);
		}
	});
});

describe("normalizeMeshStatus", () => {
	test("fills every field with its default from an empty object", () => {
		expect(normalizeMeshStatus({})).toEqual({
			enabled: false,
			reachable: false,
			backend: null,
			backendState: "Stopped",
			controlServer: null,
			magicDnsName: null,
			tailscaleIps: [],
			tailcatAddress: null,
			peers: [],
		});
	});

	test("normalizes a Tailcat address without treating it as a control server", () => {
		expect(
			normalizeMeshStatus({
				enabled: true,
				backend: "tailcat",
				reachable: true,
				tailcat_address: "tcExampleToken",
			})
		).toMatchObject({
			backend: "tailcat",
			reachable: true,
			controlServer: null,
			tailcatAddress: "tcExampleToken",
		});
	});

	test("prefers reachable but falls back to the up alias", () => {
		expect(normalizeMeshStatus({ up: true }).reachable).toBe(true);
		expect(normalizeMeshStatus({ reachable: false, up: true }).reachable).toBe(
			false
		);
	});

	test("normalizes peers to camelCase with defaults", () => {
		const status = normalizeMeshStatus({
			enabled: true,
			peers: [{ name: "pi", online: true, tailscale_ips: ["100.1.1.1"] }],
		});
		expect(status.peers[0]).toEqual({
			name: "pi",
			hostOrDns: "",
			magicDnsName: "",
			tailscaleIps: ["100.1.1.1"],
			online: true,
			os: "",
		});
	});
});

describe("flattenConfigOptions", () => {
	const option = (options: AcpConfigOption["options"]): AcpConfigOption => ({
		id: "opt",
		name: "Opt",
		type: "select",
		options,
	});

	test("returns [] when there are no options", () => {
		expect(flattenConfigOptions(option(undefined))).toEqual([]);
		expect(flattenConfigOptions(option([]))).toEqual([]);
	});

	test("returns an ungrouped list unchanged", () => {
		const opts = [
			{ name: "A", value: "a" },
			{ name: "B", value: "b" },
		];
		expect(flattenConfigOptions(option(opts))).toEqual(opts);
	});

	test("flattens the grouped form into a single list", () => {
		const grouped = [
			{ options: [{ name: "A", value: "a" }] },
			{
				options: [
					{ name: "B", value: "b" },
					{ name: "C", value: "c" },
				],
			},
		];
		expect(flattenConfigOptions(option(grouped))).toEqual([
			{ name: "A", value: "a" },
			{ name: "B", value: "b" },
			{ name: "C", value: "c" },
		]);
	});
});

describe("describeDependencyError", () => {
	const name = (id: string) => id.toUpperCase();

	test("blocked_by_dependents names the plugins to disable first", () => {
		expect(
			describeDependencyError(
				{
					code: "blocked_by_dependents",
					plugin: "core",
					dependents: ["mail", "cal"],
				},
				name
			)
		).toBe("CORE is needed by MAIL, CAL. Disable MAIL, CAL first.");
	});

	test("missing_dependency includes the version hint when present", () => {
		expect(
			describeDependencyError({
				code: "missing_dependency",
				plugin: "a",
				dependency: "b",
				required: "1.2.0",
			})
		).toBe("a needs b (1.2.0 or newer). Install it first.");
	});

	test("version_mismatch reports installed vs required", () => {
		expect(
			describeDependencyError({
				code: "version_mismatch",
				plugin: "a",
				dependency: "b",
				required: "2.0.0",
				installed: "1.0.0",
			})
		).toBe(
			"a needs b 2.0.0 or newer, but 1.0.0 is installed. Update it first."
		);
	});

	test("dependent_version_mismatch names the dependent an update would break", () => {
		expect(
			describeDependencyError({
				code: "dependent_version_mismatch",
				plugin: "@ryu/meetings",
				dependency: "@ryu/spaces",
				required: ">=1.2, <2",
				incoming: "2.0.0",
			})
		).toBe(
			"Updating @ryu/spaces to 2.0.0 would break @ryu/meetings, which needs >=1.2, <2. Update @ryu/meetings first, or force the update."
		);
	});

	test("cycle joins the chain with arrows", () => {
		expect(
			describeDependencyError({ code: "cycle", cycle: ["a", "b", "a"] })
		).toBe("Circular dependency: a → b → a.");
	});

	test("self_dependency and not_installed render their sentences", () => {
		expect(
			describeDependencyError({ code: "self_dependency", plugin: "a" })
		).toBe("a declares itself as a dependency.");
		expect(
			describeDependencyError({ code: "not_installed", plugin: "a" })
		).toBe("a is not installed.");
	});

	test("an unknown code falls back to a generic sentence, never crashes", () => {
		// A `code` the client does not know yet (Core added a variant).
		expect(
			describeDependencyError({
				code: "future_variant",
			} as unknown as DependencyError)
		).toBe("This change conflicts with the current plugin dependencies.");
	});
});

describe("generateGatewayKey", () => {
	test("produces the sk-ryu- prefix with 64 hex chars", () => {
		expect(generateGatewayKey()).toMatch(/^sk-ryu-[0-9a-f]{64}$/);
	});

	test("is unique across calls", () => {
		const a = generateGatewayKey();
		const b = generateGatewayKey();
		expect(a).not.toBe(b);
	});
});

describe("chat URL + headers", () => {
	test("chatStreamUrl points at the stream endpoint", () => {
		expect(chatStreamUrl(target())).toBe(
			"http://127.0.0.1:7980/api/chat/stream"
		);
	});

	test("chatHeaders carries only Authorization, and {} without a token", () => {
		expect(chatHeaders(target({ token: "t" }))).toEqual({
			Authorization: "Bearer t",
		});
		expect(chatHeaders(target())).toEqual({});
	});

	test("chatStreamResumeUrl encodes conversation ids", () => {
		expect(chatStreamResumeUrl(target(), "thread/a b")).toBe(
			"http://127.0.0.1:7980/api/chat/stream/resume/thread%2Fa%20b"
		);
	});

	test("cancelChat posts the conversation id and returns the server result", async () => {
		const originalFetch = globalThis.fetch;
		let body = "";
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
			body = String(init?.body ?? "");
			return Promise.resolve(Response.json({ cancelled: true }));
		}) as unknown as typeof fetch;
		try {
			expect(await cancelChat(target(), "c1")).toBe(true);
			expect(body).toBe(JSON.stringify({ conversation_id: "c1" }));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("answerNowChat posts the native turn control request", async () => {
		const originalFetch = globalThis.fetch;
		let body = "";
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
			body = String(init?.body ?? "");
			return Promise.resolve(Response.json({ accepted: true }));
		}) as unknown as typeof fetch;
		try {
			expect(await answerNowChat(target(), "c1", "turn_1")).toBe(true);
			expect(body).toBe(
				JSON.stringify({
					action: "answer_now",
					conversation_id: "c1",
					turn_id: "turn_1",
				})
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("suggestion failures degrade to an empty list", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.reject(new Error("offline"))) as unknown as typeof fetch;
		try {
			expect(await fetchNextPromptSuggestions(target(), "c1")).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("voiceWsUrl", () => {
	test("upgrades http→ws and attaches token + jwt", () => {
		const url = new URL(voiceWsUrl(target({ token: "node" }), "jwt-1"));
		expect(url.protocol).toBe("ws:");
		expect(url.pathname).toBe("/api/voice/ws");
		expect(url.searchParams.get("token")).toBe("node");
		expect(url.searchParams.get("jwt")).toBe("jwt-1");
	});

	test("upgrades https→wss and omits an absent token/jwt", () => {
		const url = new URL(voiceWsUrl(target({ url: "https://h", token: null })));
		expect(url.protocol).toBe("wss:");
		expect(url.searchParams.get("token")).toBeNull();
		expect(url.searchParams.get("jwt")).toBeNull();
	});
});
