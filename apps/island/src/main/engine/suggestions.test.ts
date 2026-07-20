import { describe, expect, it } from "bun:test";
import type {
	FeedbackKind,
	IslandSuggestion,
	ShadowContext,
	ShadowContextResult,
	ShadowProactiveResult,
} from "../../shared/ipc.ts";
import { SuggestionEngine, type SuggestionEngineDeps } from "./suggestions.ts";

function context(partial: Partial<ShadowContext>): ShadowContext {
	return {
		app_name: "Code",
		window_title: "main.ts",
		ocr_text: "some code on screen",
		selected_text: null,
		capture_active: true,
		paused: false,
		ocr_timestamp_us: null,
		timestamp_us: null,
		...partial,
	};
}

interface Harness {
	cleared: { count: number };
	deps: SuggestionEngineDeps;
	emitted: IslandSuggestion[];
	feedbackCalls: { kind: FeedbackKind; type: string }[];
	setContext(ctx: ShadowContext): void;
	setModelText(text: string | null): void;
	setProactive(result: ShadowProactiveResult): void;
}

function makeHarness(): Harness {
	let ctx: ShadowContext = context({});
	let modelText: string | null =
		'{"relevant":true,"title":"Help","body":"b","confidence":0.9}';
	let proactive: ShadowProactiveResult = { available: true, suggestion: null };
	const emitted: IslandSuggestion[] = [];
	const cleared = { count: 0 };
	const feedbackCalls: { kind: FeedbackKind; type: string }[] = [];

	const deps: SuggestionEngineDeps = {
		getContext: (): Promise<ShadowContextResult> =>
			Promise.resolve({ available: true, context: ctx }),
		getProactive: (): Promise<ShadowProactiveResult> =>
			Promise.resolve(proactive),
		complete: (): Promise<string | null> => Promise.resolve(modelText),
		postFeedback: (kind, type): Promise<void> => {
			feedbackCalls.push({ kind, type });
			return Promise.resolve();
		},
		emit: (s): void => {
			emitted.push(s);
		},
		emitCleared: (): void => {
			cleared.count += 1;
		},
	};

	return {
		deps,
		emitted,
		cleared,
		feedbackCalls,
		setContext: (next): void => {
			ctx = next;
		},
		setModelText: (text): void => {
			modelText = text;
		},
		setProactive: (result): void => {
			proactive = result;
		},
	};
}

// The private tick methods are exercised via casting; the engine is otherwise a
// black box. This keeps the test honest about the public contract (emit + dedupe
// + cooldown) without spinning real interval timers.
interface EnginePrivate {
	maybeFirePending(now: number): Promise<void>;
	runContextTick(): Promise<void>;
	runProactiveTick(): Promise<void>;
}

function asPrivate(engine: SuggestionEngine): EnginePrivate {
	return engine as unknown as EnginePrivate;
}

describe("SuggestionEngine", () => {
	it("emits a local-model suggestion after a settled change past debounce", async () => {
		const h = makeHarness();
		const engine = new SuggestionEngine(h.deps, {
			debounceMs: 1,
			cooldownMs: 100_000,
		});
		const priv = asPrivate(engine);

		// First tick establishes the baseline (reason: first -> pending).
		await priv.runContextTick();
		// A later tick with the SAME context (no change) settles the pending one.
		await new Promise((r) => setTimeout(r, 5));
		await priv.runContextTick();

		expect(h.emitted).toHaveLength(1);
		expect(h.emitted[0]?.source).toBe("local_model");
		expect(h.emitted[0]?.title).toBe("Help");
	});

	it("does not re-emit the same suggestion (dedupe)", async () => {
		const h = makeHarness();
		const engine = new SuggestionEngine(h.deps, {
			debounceMs: 1,
			cooldownMs: 0,
		});
		const priv = asPrivate(engine);

		await priv.runContextTick();
		await new Promise((r) => setTimeout(r, 5));
		await priv.runContextTick();
		// Force another fire with the same context + model output.
		await new Promise((r) => setTimeout(r, 5));
		await priv.runContextTick();

		expect(h.emitted).toHaveLength(1);
	});

	it("drops irrelevant model output without emitting or crashing", async () => {
		const h = makeHarness();
		h.setModelText('{"relevant":false,"title":"x","confidence":0.9}');
		const engine = new SuggestionEngine(h.deps, { debounceMs: 1 });
		const priv = asPrivate(engine);

		await priv.runContextTick();
		await new Promise((r) => setTimeout(r, 5));
		await priv.runContextTick();

		expect(h.emitted).toHaveLength(0);
	});

	it("never crashes on malformed model output", async () => {
		const h = makeHarness();
		h.setModelText("this is not json at all");
		const engine = new SuggestionEngine(h.deps, { debounceMs: 1 });
		const priv = asPrivate(engine);

		await priv.runContextTick();
		await new Promise((r) => setTimeout(r, 5));
		await expect(priv.runContextTick()).resolves.toBeUndefined();
		expect(h.emitted).toHaveLength(0);
	});

	it("surfaces a push_now proactive suggestion", async () => {
		const h = makeHarness();
		h.setProactive({
			available: true,
			suggestion: {
				id: "p1",
				title: "Shadow tip",
				body: "from shadow",
				confidence: 0.7,
				created_at: 0,
				disposition: "push_now",
				metadata: {},
				suggestion_type: "reminder",
			},
		});
		const engine = new SuggestionEngine(h.deps);
		await asPrivate(engine).runProactiveTick();

		expect(h.emitted).toHaveLength(1);
		expect(h.emitted[0]?.source).toBe("shadow_proactive");
		expect(h.emitted[0]?.suggestionType).toBe("reminder");
	});

	it("emits cleared and resets state on stop", () => {
		const h = makeHarness();
		const engine = new SuggestionEngine(h.deps);
		engine.start();
		const status = engine.stop();
		expect(h.cleared.count).toBe(1);
		expect(status.running).toBe(false);
	});

	it("routes feedback to shadow and extends cooldown on dismiss", async () => {
		const h = makeHarness();
		const engine = new SuggestionEngine(h.deps, {
			debounceMs: 1,
			cooldownMs: 0,
		});
		const priv = asPrivate(engine);
		await priv.runContextTick();
		await new Promise((r) => setTimeout(r, 5));
		await priv.runContextTick();

		const id = h.emitted[0]?.id ?? "";
		await engine.feedback(id, "dismiss");
		expect(h.feedbackCalls).toHaveLength(1);
		expect(h.feedbackCalls[0]?.kind).toBe("dismiss");
		expect(h.feedbackCalls[0]?.type).toBe("context");
	});
});
