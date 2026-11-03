import { describe, expect, it } from "bun:test";
import type { CoreChatMessage } from "../../shared/ipc.ts";
import { SuggestionEngine, type SuggestionEngineDeps } from "./suggestions.ts";

const MODEL_TEXT =
	'{"relevant":true,"title":"Aide","body":"b","confidence":0.9}';

function harness(uiLocale?: SuggestionEngineDeps["uiLocale"]): {
	deps: SuggestionEngineDeps;
	sent: CoreChatMessage[][];
} {
	const sent: CoreChatMessage[][] = [];
	const deps: SuggestionEngineDeps = {
		getContext: () =>
			Promise.resolve({
				available: true,
				context: {
					app_name: "Code",
					window_title: "main.ts",
					ocr_text: "some code on screen",
					selected_text: null,
					capture_active: true,
					paused: false,
					ocr_timestamp_us: null,
					timestamp_us: null,
				},
			}),
		getProactive: () => Promise.resolve({ available: true, suggestion: null }),
		complete: (messages) => {
			sent.push(messages);
			return Promise.resolve(MODEL_TEXT);
		},
		postFeedback: () => Promise.resolve(),
		emit: () => undefined,
		emitCleared: () => undefined,
		uiLocale,
	};
	return { deps, sent };
}

// The context tick is private; bind it the way suggestions.test.ts does.
const CONTEXT_TICK = "runContextTick" as const;

/** The system prompts sent to the model for one settled context change. */
async function systemPromptsSent(
	uiLocale?: SuggestionEngineDeps["uiLocale"]
): Promise<string[]> {
	const h = harness(uiLocale);
	const engine = new SuggestionEngine(h.deps, {
		debounceMs: 1,
		cooldownMs: 100_000,
	});
	const tick = () => engine[CONTEXT_TICK]();
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 5));
	await tick();
	return h.sent.map((messages) => messages[0]?.content ?? "");
}

describe("SuggestionEngine UI language", () => {
	it("asks the model for the Island's UI language", async () => {
		const [prompt, ...rest] = await systemPromptsSent(() =>
			Promise.resolve("fr")
		);
		expect(rest).toHaveLength(0);
		expect(prompt).toContain(
			"Write every sentence meant for the user in French."
		);
	});

	it("keeps the English prompt without a locale or when reading it fails", async () => {
		const [english] = await systemPromptsSent();
		expect(english).toContain("STRICT JSON");
		expect(english).not.toContain("Write every sentence");
		const failed = await systemPromptsSent(() =>
			Promise.reject(new Error("core down"))
		);
		expect(failed).toEqual([english]);
	});
});
