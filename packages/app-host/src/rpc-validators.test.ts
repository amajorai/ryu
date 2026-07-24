// Unit coverage for the pure RPC ARGUMENT VALIDATORS in rpc.ts that the existing
// suites (app-bridge / widget-mount / adversarial / rpc) don't already exercise.
// Each validator is the narrow gate a host method's args pass through before the
// service runs; a hole here widens the dispatch surface or forwards a malformed
// shape to Core. These assert the accept/reject boundary — notably URL-scheme
// vetting, numeric-bound rejection (NaN/Infinity/negative), and the
// Record<string,string>-only input maps — DOM-free, no port needed.

import { describe, expect, test } from "bun:test";
import {
	asComposioArg,
	asDisplayModeArg,
	asMediaImageArg,
	asMediaTtsArg,
	asOpenExternalArg,
	asPromptArg,
	asRouteClaim,
	asShellOpenTabArg,
	asWorkflowResumeArg,
	asWorkflowRunArg,
	type Capability,
	CodedRpcError,
	capabilitiesFromGrants,
	toRpcError,
} from "./rpc.ts";

describe("asOpenExternalArg — scheme vetting", () => {
	test("accepts http(s) from a bare string, { href }, and { url }", () => {
		expect(asOpenExternalArg("https://example.com/x")).toEqual({
			href: "https://example.com/x",
		});
		expect(asOpenExternalArg({ href: "http://example.com/" })).toEqual({
			href: "http://example.com/",
		});
		// `url` is the openai-shim alias for `href`.
		expect(asOpenExternalArg({ url: "https://a.test/p" })).toEqual({
			href: "https://a.test/p",
		});
	});

	test("rejects dangerous non-http(s) schemes", () => {
		for (const bad of [
			"javascript:alert(1)",
			"file:///etc/passwd",
			"data:text/html,<script>1</script>",
			"ftp://host/f",
			"chrome://settings",
		]) {
			expect(asOpenExternalArg(bad)).toBeNull();
		}
	});

	test("rejects malformed URLs, empty strings, and non-string shapes", () => {
		expect(asOpenExternalArg("not a url")).toBeNull();
		expect(asOpenExternalArg("")).toBeNull();
		expect(asOpenExternalArg({ href: "" })).toBeNull();
		expect(asOpenExternalArg({ href: 42 })).toBeNull();
		expect(asOpenExternalArg(null)).toBeNull();
		expect(asOpenExternalArg({})).toBeNull();
	});
});

describe("asDisplayModeArg", () => {
	test("accepts a bare mode string or a { mode } object", () => {
		expect(asDisplayModeArg("inline")).toBe("inline");
		expect(asDisplayModeArg("fullscreen")).toBe("fullscreen");
		expect(asDisplayModeArg({ mode: "pip" })).toBe("pip");
	});

	test("rejects unknown modes and non-mode shapes", () => {
		expect(asDisplayModeArg("modal")).toBeNull();
		expect(asDisplayModeArg({ mode: "sidebar" })).toBeNull();
		expect(asDisplayModeArg({})).toBeNull();
		expect(asDisplayModeArg(null)).toBeNull();
		expect(asDisplayModeArg(3)).toBeNull();
	});
});

describe("asShellOpenTabArg", () => {
	test("requires a non-empty path and copies only well-typed options", () => {
		expect(
			asShellOpenTabArg({
				path: "/chat",
				title: "Chat",
				conversationId: "c1",
				forceNew: true,
				initialPrompt: "hi",
			})
		).toEqual({
			path: "/chat",
			title: "Chat",
			conversationId: "c1",
			forceNew: true,
			initialPrompt: "hi",
		});
	});

	test("drops mistyped optionals rather than failing the whole arg", () => {
		expect(
			asShellOpenTabArg({ path: "/chat", title: 5, forceNew: "yes" })
		).toEqual({ path: "/chat" });
	});

	test("rejects a missing / empty path or non-object", () => {
		expect(asShellOpenTabArg({ path: "" })).toBeNull();
		expect(asShellOpenTabArg({ title: "no path" })).toBeNull();
		expect(asShellOpenTabArg(null)).toBeNull();
		expect(asShellOpenTabArg("/chat")).toBeNull();
	});
});

describe("asMediaImageArg — numeric bound on count", () => {
	test("accepts a non-negative finite count and optional strings", () => {
		expect(asMediaImageArg({ prompt: "cat", count: 4, size: "1024" })).toEqual({
			prompt: "cat",
			count: 4,
			size: "1024",
		});
		// count is optional; zero is allowed (>= 0).
		expect(asMediaImageArg({ prompt: "cat", count: 0 })).toEqual({
			prompt: "cat",
			count: 0,
		});
		expect(asMediaImageArg({ prompt: "cat" })).toEqual({ prompt: "cat" });
	});

	test("rejects a negative, NaN, or Infinite count", () => {
		expect(asMediaImageArg({ prompt: "cat", count: -1 })).toBeNull();
		expect(asMediaImageArg({ prompt: "cat", count: Number.NaN })).toBeNull();
		expect(
			asMediaImageArg({ prompt: "cat", count: Number.POSITIVE_INFINITY })
		).toBeNull();
	});

	test("rejects an empty prompt or a mistyped optional string", () => {
		expect(asMediaImageArg({ prompt: "" })).toBeNull();
		expect(asMediaImageArg({ prompt: "cat", size: 512 })).toBeNull();
		expect(asMediaImageArg(null)).toBeNull();
	});
});

describe("asMediaTtsArg — numeric bound on speed", () => {
	test("accepts text with optional engine/voice/language/speed", () => {
		expect(
			asMediaTtsArg({ text: "hello", engine: "e", voice: "v", speed: 1.5 })
		).toEqual({ text: "hello", engine: "e", voice: "v", speed: 1.5 });
	});

	test("rejects empty text and out-of-range speed", () => {
		expect(asMediaTtsArg({ text: "" })).toBeNull();
		expect(asMediaTtsArg({ text: "hi", speed: -0.5 })).toBeNull();
		expect(asMediaTtsArg({ text: "hi", speed: Number.NaN })).toBeNull();
		expect(asMediaTtsArg({ text: "hi", voice: 9 })).toBeNull();
	});
});

describe("asWorkflowRunArg — input must be Record<string, string>", () => {
	test("accepts a bare { id } with no input", () => {
		expect(asWorkflowRunArg({ id: "wf-1" })).toEqual({ id: "wf-1" });
	});

	test("accepts an all-string input map", () => {
		expect(
			asWorkflowRunArg({ id: "wf-1", input: { a: "1", b: "two" } })
		).toEqual({ id: "wf-1", input: { a: "1", b: "two" } });
	});

	test("rejects an array input or a non-string input value", () => {
		expect(asWorkflowRunArg({ id: "wf-1", input: ["a"] })).toBeNull();
		expect(asWorkflowRunArg({ id: "wf-1", input: { a: 1 } })).toBeNull();
		expect(asWorkflowRunArg({ id: "wf-1", input: null })).toBeNull();
	});

	test("rejects a missing / empty id", () => {
		expect(asWorkflowRunArg({ id: "" })).toBeNull();
		expect(asWorkflowRunArg({})).toBeNull();
		expect(asWorkflowRunArg(null)).toBeNull();
	});
});

describe("asWorkflowResumeArg", () => {
	test("requires a non-empty runId and a string payload", () => {
		expect(asWorkflowResumeArg({ runId: "r1", payload: "{}" })).toEqual({
			runId: "r1",
			payload: "{}",
		});
		// empty-string payload is allowed (present + string), only runId must be non-empty.
		expect(asWorkflowResumeArg({ runId: "r1", payload: "" })).toEqual({
			runId: "r1",
			payload: "",
		});
	});

	test("rejects a missing payload or empty runId", () => {
		expect(asWorkflowResumeArg({ runId: "r1" })).toBeNull();
		expect(asWorkflowResumeArg({ runId: "", payload: "{}" })).toBeNull();
		expect(asWorkflowResumeArg({ runId: "r1", payload: 5 })).toBeNull();
	});
});

describe("asComposioArg — closed kind set", () => {
	test("accepts each blessed kind with an optional toolkit", () => {
		for (const kind of [
			"status",
			"toolkits",
			"triggers",
			"connections",
		] as const) {
			expect(asComposioArg({ kind })).toEqual({ kind });
		}
		expect(asComposioArg({ kind: "triggers", toolkit: "github" })).toEqual({
			kind: "triggers",
			toolkit: "github",
		});
	});

	test("rejects an unknown kind or a mistyped toolkit", () => {
		expect(asComposioArg({ kind: "list" })).toBeNull();
		expect(asComposioArg({ kind: "status", toolkit: 7 })).toBeNull();
		expect(asComposioArg({})).toBeNull();
		expect(asComposioArg(null)).toBeNull();
	});
});

describe("asPromptArg", () => {
	test("requires a non-empty prompt string", () => {
		expect(asPromptArg({ prompt: "go" })).toEqual({ prompt: "go" });
		expect(asPromptArg({ prompt: "" })).toBeNull();
		expect(asPromptArg({ prompt: 1 })).toBeNull();
		expect(asPromptArg(null)).toBeNull();
	});
});

describe("asRouteClaim", () => {
	test("narrows to { path, title } and drops extra fields", () => {
		expect(
			asRouteClaim({ path: "/plugin/app", title: "Demo", extra: 1 })
		).toEqual({ path: "/plugin/app", title: "Demo" });
	});

	test("rejects a claim missing path or title (never reaches validatePluginRoute)", () => {
		expect(asRouteClaim({ path: "/plugin/app" })).toBeNull();
		expect(asRouteClaim({ title: "Demo" })).toBeNull();
		expect(asRouteClaim({ path: 1, title: "Demo" })).toBeNull();
		expect(asRouteClaim(null)).toBeNull();
	});
});

describe("toRpcError — coded vs plain serialization", () => {
	test("a CodedRpcError becomes a structured { code, message }", () => {
		const out = toRpcError(new CodedRpcError("denied", "nope"));
		expect(out).toEqual({ code: "denied", message: "nope" });
	});

	test("any object carrying a string code is treated as coded", () => {
		expect(toRpcError({ code: "over_budget", message: "too much" })).toEqual({
			code: "over_budget",
			message: "too much",
		});
	});

	test("a plain Error serializes to its message string (legacy plugin shape)", () => {
		expect(toRpcError(new Error("boom"))).toBe("boom");
	});

	test("a non-Error primitive serializes via String()", () => {
		expect(toRpcError("raw string")).toBe("raw string");
		expect(toRpcError(123)).toBe("123");
	});

	test("an object whose code is not a string falls through to String()", () => {
		// code present but numeric → NOT treated as coded; falls to the String() branch.
		const out = toRpcError({ code: 500 });
		expect(typeof out).toBe("string");
	});
});

describe("capabilitiesFromGrants", () => {
	test("maps known grants and silently ignores unknown ones", () => {
		const caps = capabilitiesFromGrants([
			"storage:kv",
			"totally:made-up",
			"spaces:docs",
		]);
		expect(caps.has("storage.kv" as Capability)).toBe(true);
		expect(caps.has("spaces.docs" as Capability)).toBe(true);
		// The bogus grant contributes nothing — only the two real caps.
		expect(caps.size).toBe(2);
	});

	test("an empty grant list yields no capabilities", () => {
		expect(capabilitiesFromGrants([]).size).toBe(0);
	});
});
