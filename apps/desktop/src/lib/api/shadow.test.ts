// apps/desktop/src/lib/api/shadow.test.ts
//
// Unit tests for the Shadow API client module. Tests cover both the happy-path
// response shapes and the graceful-degradation behaviour when Shadow :3030 is
// unreachable.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type {
	FeedbackKind,
	ProactiveSuggestion,
	ShadowComputerUseResult,
	ShadowContext,
} from "./shadow.ts";
import {
	getCurrentContext,
	getProactive,
	getShadowComputerUseConfig,
	getTimeline,
	postFeedback,
	runShadowComputerUse,
	setShadowComputerUseConfig,
} from "./shadow.ts";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

const recordedBodySchema = z.json();
type RecordedBody = z.infer<typeof recordedBodySchema>;
function mockFetch(response: string, status = 200, _ok = true) {
	return Object.assign(
		mock(
			async () =>
				new Response(response, {
					status,
					headers: { "content-type": "application/json" },
				})
		),
		{ preconnect: originalFetch.preconnect }
	);
}

// ---------------------------------------------------------------------------
// getCurrentContext
// ---------------------------------------------------------------------------

describe("getCurrentContext", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns typed context on 200", async () => {
		const payload: ShadowContext = {
			active_app: "Visual Studio Code",
			screen_text: "hello world",
			selected_text: "hello",
			window_title: "main.ts — ryu",
		};
		globalThis.fetch = mockFetch(JSON.stringify(payload));

		const result = await getCurrentContext();

		expect(result).not.toBeNull();
		expect(result?.active_app).toBe("Visual Studio Code");
		expect(result?.selected_text).toBe("hello");
	});

	test("returns null on non-ok response", async () => {
		globalThis.fetch = mockFetch(JSON.stringify({}), 500, false);

		const result = await getCurrentContext();
		expect(result).toBeNull();
	});

	test("returns null when fetch throws (Shadow unreachable)", async () => {
		globalThis.fetch = Object.assign(
			mock(() => {
				throw new Error("connection refused");
			}),
			{ preconnect: originalFetch.preconnect }
		);

		const result = await getCurrentContext();
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// getProactive
// ---------------------------------------------------------------------------

/** Minimal valid ProactiveSuggestion fixture. */
function makeSuggestion(
	overrides: Partial<ProactiveSuggestion> = {}
): ProactiveSuggestion {
	return {
		id: "sug-1",
		suggestion_type: "action",
		title: "Summarize this page?",
		body: "You have been reading for a while.",
		confidence: 0.85,
		disposition: "push_now",
		created_at: 1_700_000_000,
		metadata: {},
		...overrides,
	};
}

describe("getProactive", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("returns the first push_now suggestion from the list", async () => {
		const suggestions = [
			makeSuggestion({ id: "sug-1", disposition: "push_now" }),
			makeSuggestion({ id: "sug-2", disposition: "inbox_only" }),
		];
		globalThis.fetch = mockFetch(
			JSON.stringify({
				suggestions,
			})
		);

		const result = await getProactive();

		expect(result).not.toBeNull();
		expect(result?.id).toBe("sug-1");
		expect(result?.title).toBe("Summarize this page?");
		expect(result?.disposition).toBe("push_now");
	});

	test("returns null when no push_now suggestions exist", async () => {
		const suggestions = [
			makeSuggestion({ disposition: "inbox_only" }),
			makeSuggestion({ disposition: "drop" }),
		];
		globalThis.fetch = mockFetch(JSON.stringify({ suggestions }));

		const result = await getProactive();
		expect(result).toBeNull();
	});

	test("returns null when suggestions array is empty", async () => {
		globalThis.fetch = mockFetch(
			JSON.stringify({
				suggestions: [],
			})
		);

		const result = await getProactive();
		expect(result).toBeNull();
	});

	test("returns null on non-ok response", async () => {
		globalThis.fetch = mockFetch(JSON.stringify({}), 404, false);

		const result = await getProactive();
		expect(result).toBeNull();
	});

	test("returns null when fetch throws (Shadow unreachable)", async () => {
		globalThis.fetch = Object.assign(
			mock(() => {
				throw new Error("connection refused");
			}),
			{ preconnect: originalFetch.preconnect }
		);

		const result = await getProactive();
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// postFeedback — AC4: feedback actions map to correct FeedbackKind payloads
// ---------------------------------------------------------------------------

describe("postFeedback", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	/** Capture the request body that fetch was called with. */
	function captureFetch(status = 200, ok = true) {
		let captured: RecordedBody | undefined;
		const fetchMock = mock((_url: RequestInfo | URL, init?: RequestInit) => {
			const body = z.string().safeParse(init?.body);
			captured = body.success
				? recordedBodySchema.parse(JSON.parse(body.data))
				: undefined;
			return Promise.resolve(Response.json({ applied: ok }, { status }));
		});
		globalThis.fetch = Object.assign(fetchMock, {
			preconnect: originalFetch.preconnect,
		});
		return { getCaptured: () => captured };
	}

	const FEEDBACK_CASES: Array<{ label: string; kind: FeedbackKind }> = [
		{ label: "accept maps to thumbs_up", kind: "thumbs_up" },
		{ label: "dismiss maps to dismiss", kind: "dismiss" },
		{ label: "snooze maps to snooze", kind: "snooze" },
	];

	for (const { label, kind } of FEEDBACK_CASES) {
		test(label, async () => {
			const { getCaptured } = captureFetch();

			const ok = await postFeedback({ suggestion_type: "action", kind });

			expect(ok).toBe(true);
			expect(getCaptured()).toEqual({ suggestion_type: "action", kind });
		});
	}

	test("returns false when Shadow is unreachable", async () => {
		globalThis.fetch = Object.assign(
			mock(() => {
				throw new Error("connection refused");
			}),
			{ preconnect: originalFetch.preconnect }
		);

		const ok = await postFeedback({
			suggestion_type: "action",
			kind: "dismiss",
		});
		expect(ok).toBe(false);
	});

	test("returns false on non-ok response", async () => {
		captureFetch(500, false);

		const ok = await postFeedback({
			suggestion_type: "action",
			kind: "thumbs_up",
		});
		expect(ok).toBe(false);
	});
});

describe("Shadow computer-use settings", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const config = {
		applied: false,
		jevApiKeyConfigured: true,
		jevModel: "jev-latest",
		jevUrl: "https://api.typesafe.ai/v1/systemone",
		layaUrl: "http://127.0.0.1:8980/api/ext/@ryu/laya/predict",
		localPluginId: "@ryu/laya",
		localModelId: "router",
		maxSteps: 12,
		planner: "laya" as const,
	};

	test("loads saved settings and the applied state", async () => {
		globalThis.fetch = mockFetch(JSON.stringify(config));

		await expect(getShadowComputerUseConfig()).resolves.toEqual(config);
	});

	test("saves offline settings without requiring Shadow to be running", async () => {
		let capturedBody: RecordedBody | undefined;
		globalThis.fetch = Object.assign(
			mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedBody = recordedBodySchema.parse(
					JSON.parse(z.string().parse(init?.body))
				);
				return Response.json(config);
			}),
			{ preconnect: originalFetch.preconnect }
		);

		const saved = await setShadowComputerUseConfig({
			jevModel: config.jevModel,
			jevUrl: config.jevUrl,
			layaUrl: config.layaUrl,
			localPluginId: config.localPluginId,
			localModelId: config.localModelId,
			maxSteps: config.maxSteps,
			planner: config.planner,
		});

		expect(saved.applied).toBe(false);
		expect(capturedBody).toEqual({
			jevModel: config.jevModel,
			jevUrl: config.jevUrl,
			layaUrl: config.layaUrl,
			localPluginId: config.localPluginId,
			localModelId: config.localModelId,
			maxSteps: config.maxSteps,
			planner: config.planner,
		});
	});

	test("rejects config responses missing the applied status", async () => {
		const { applied: _applied, ...legacyConfig } = config;
		globalThis.fetch = mockFetch(JSON.stringify(legacyConfig));

		await expect(getShadowComputerUseConfig()).resolves.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Companion pill display logic (unit-tested without a React renderer)
// ---------------------------------------------------------------------------

describe("companion pill display logic", () => {
	const SELECTION_PREVIEW_MAX = 120;

	function buildPillText(
		context: ShadowContext | null,
		unavailable: boolean
	): string {
		if (unavailable) {
			return "context unavailable";
		}
		if (!context?.active_app) {
			return "ready";
		}
		const selectedText =
			context.selected_text?.slice(0, SELECTION_PREVIEW_MAX) ?? "";
		const overflow =
			(context.selected_text?.length ?? 0) > SELECTION_PREVIEW_MAX;
		if (selectedText) {
			return `${context.active_app} · "${selectedText}${overflow ? "…" : ""}"`;
		}
		return context.active_app;
	}

	test("shows app name and truncated selection", () => {
		const ctx: ShadowContext = {
			active_app: "Chrome",
			screen_text: null,
			selected_text: "A".repeat(130),
			window_title: null,
		};
		const text = buildPillText(ctx, false);
		expect(text).toContain("Chrome");
		expect(text).toContain("…");
		expect(text.includes("A".repeat(120))).toBe(true);
		// Must not include the 121st char
		expect(text.includes("A".repeat(121))).toBe(false);
	});

	test("shows app name without selection when selection is null", () => {
		const ctx: ShadowContext = {
			active_app: "Terminal",
			screen_text: "ls -la",
			selected_text: null,
			window_title: null,
		};
		const text = buildPillText(ctx, false);
		expect(text).toBe("Terminal");
	});

	test("shows 'context unavailable' when Shadow is down", () => {
		const text = buildPillText(null, true);
		expect(text).toBe("context unavailable");
	});

	test("shows 'ready' when context is null but Shadow has not reported down", () => {
		const text = buildPillText(null, false);
		expect(text).toBe("ready");
	});
});

describe("Shadow response validation", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});
	test("keeps malformed timeline rows away from the activity renderer", async () => {
		globalThis.fetch = mockFetch(
			JSON.stringify({
				entries: [{ ts: "yesterday", event_type: "app_switch" }],
			})
		);
		expect(await getTimeline(10)).toBeNull();
	});
	test("retains nullable targets in validated computer-use steps", async () => {
		const result = {
			planner: "native",
			status: "completed",
			message: "done",
			steps: [{ operation: "click", outcome: "ok", target: null }],
		} satisfies ShadowComputerUseResult;
		globalThis.fetch = mockFetch(JSON.stringify(result));
		expect(await runShadowComputerUse("Finish the task")).toEqual(result);
	});
	test("preserves the specific error for an invalid computer-use target", async () => {
		globalThis.fetch = mockFetch(
			JSON.stringify({
				planner: "native",
				status: "completed",
				message: "done",
				steps: [{ operation: "click", outcome: "ok", target: 12 }],
			})
		);
		await expect(runShadowComputerUse("Finish the task")).rejects.toThrow(
			"Shadow returned an invalid computer-use target"
		);
	});
});
