import { afterEach, expect, jest, test } from "bun:test";
import { createHighlighter } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import type { CodeHighlighterPlugin } from "streamdown";
import {
	staticCodeHighlighter,
	streamingCodeHighlighter,
} from "./code-highlighter.ts";

type HighlightResult = NonNullable<
	ReturnType<CodeHighlighterPlugin["highlight"]>
>;

const THEMES: ["github-light", "github-dark"] = ["github-light", "github-dark"];

// Mirrors STREAM_REDRAW_INTERVAL_MS. The throttle reads performance.now() and
// arms a setTimeout, so the throttled sections run on fake timers (which
// drive both) instead of racing real sleeps against a wall-clock window.
const STREAM_REDRAW_INTERVAL_MS = 100;

// The highlighter caches by source for the whole process, and `--rerun-each`
// re-evaluates this file but not the module under test, so each run streams
// sources it has not seen before. The counter lives on globalThis to survive
// that re-evaluation.
const STREAM_RUN_KEY = Symbol.for("ryu.code-highlighter.test.stream-run");
function nextStreamRun(): number {
	const run = Number(Reflect.get(globalThis, STREAM_RUN_KEY) ?? 0) + 1;
	Reflect.set(globalThis, STREAM_RUN_KEY, run);
	return run;
}

afterEach(() => {
	jest.useRealTimers();
});

function highlight(
	plugin: CodeHighlighterPlugin,
	code: string
): Promise<HighlightResult> {
	return new Promise((resolve) => {
		const result = plugin.highlight(
			{ code, language: "ts", themes: THEMES },
			resolve
		);
		if (result) {
			resolve(result);
		}
	});
}

type NativeHighlightResult = ReturnType<
	Awaited<ReturnType<typeof createHighlighter>>["codeToTokens"]
>;

function tokenSignature(
	result: HighlightResult | NativeHighlightResult
): string {
	return JSON.stringify(
		result.tokens.map((line) =>
			line.map((token) => [token.content, token.htmlStyle ?? token.color])
		)
	);
}

test("finished blocks whose code is a prefix of another both highlight", async () => {
	// Superseding queued passes is streaming-only: in a finished reply two
	// blocks can legitimately share a prefix and each needs its own result.
	const [short, long] = await Promise.all([
		highlight(staticCodeHighlighter, "const a"),
		highlight(staticCodeHighlighter, "const a = 1;"),
	]);
	const text = (result: HighlightResult) =>
		result.tokens.map((line) => line.map((t) => t.content).join("")).join("\n");
	expect(text(short)).toBe("const a");
	expect(text(long)).toBe("const a = 1;");
});

test("a streaming block redraws at most once per interval and never stays behind", async () => {
	const text = (result: HighlightResult) =>
		result.tokens.map((line) => line.map((t) => t.content).join("")).join("\n");
	const run = nextStreamRun();
	await highlight(streamingCodeHighlighter, `let warm${run} = 0;`);
	jest.useFakeTimers();

	const firstCode = `let total${run} = 1;`;
	const secondCode = `${firstCode}\nlet next = 2;`;
	const first = streamingCodeHighlighter.highlight({
		code: firstCode,
		language: "ts",
		themes: THEMES,
	});
	let delivered: HighlightResult | null = null;
	const second = streamingCodeHighlighter.highlight(
		{ code: secondCode, language: "ts", themes: THEMES },
		(result) => {
			delivered = result;
		}
	);
	// Same object back: Streamdown's memo skips redrawing the block.
	expect(second).toBe(first);
	expect(delivered).toBeNull();

	jest.advanceTimersByTime(STREAM_REDRAW_INTERVAL_MS - 1);
	expect(delivered).toBeNull();
	jest.advanceTimersByTime(1);
	expect(delivered).not.toBeNull();
	expect(text(delivered!)).toBe(secondCode);
});

test("a streamed block resumes tokenizing and matches a full pass", async () => {
	const run = nextStreamRun();
	const code = [
		`/* a comment that (run ${run})`,
		"   spans lines */",
		"export function handler(input: string): Promise<number> {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Test source deliberately includes a multiline template interpolation.
		"\tconst template = `value ${input}",
		"continues`;",
		'\treturn fetch("/api").then((response) => response.json());',
		"}",
		"",
	].join("\n");

	// Warm the tokenizer so every streamed chunk takes the synchronous path.
	await highlight(streamingCodeHighlighter, `const warm${run} = 1;`);
	jest.useFakeTimers();

	let chunks = 0;
	let synchronous = 0;
	for (let end = 1; end <= code.length; end += 7) {
		chunks++;
		const result = streamingCodeHighlighter.highlight({
			code: code.slice(0, end),
			language: "ts",
			themes: THEMES,
		});
		if (result) {
			synchronous++;
		}
	}
	expect(synchronous).toBe(chunks);
	// The final chunk may be held back by the redraw throttle; its trailing
	// flush tokenizes and caches the final code.
	streamingCodeHighlighter.highlight({ code, language: "ts", themes: THEMES });
	jest.advanceTimersByTime(STREAM_REDRAW_INTERVAL_MS);
	jest.useRealTimers();
	const streamed = await highlight(streamingCodeHighlighter, code);

	// An independent full pass: the plugin's own cache already holds `code`.
	const reference = await createHighlighter({
		engine: createOnigurumaEngine(import("shiki/wasm")),
		langs: ["ts"],
		themes: THEMES,
	});
	const expected = reference.codeToTokens(code, {
		lang: "ts",
		themes: { dark: THEMES[1], light: THEMES[0] },
	});
	const shifted = reference.codeToTokens(`x${code}`, {
		lang: "ts",
		themes: { dark: THEMES[1], light: THEMES[0] },
	});

	expect(tokenSignature(streamed)).toBe(tokenSignature(expected));
	// The signature does tell different tokenizations apart.
	expect(tokenSignature(shifted)).not.toBe(tokenSignature(expected));
});

test("queued streaming prefix consumers each receive their exact result", async () => {
	// A cold language forces the actual asynchronous tokenizer/queue path.
	const request = (code: string) =>
		new Promise<HighlightResult>((resolve) => {
			const result = streamingCodeHighlighter.highlight(
				{ code, language: "rust", themes: THEMES },
				resolve
			);
			if (result) {
				resolve(result);
			}
		});
	const [short, long] = await Promise.all([
		request("fn callback_regression"),
		request("fn callback_regression() {}"),
	]);
	const text = (result: HighlightResult) =>
		result.tokens
			.map((line) => line.map((token) => token.content).join(""))
			.join("\n");
	expect(text(short)).toBe("fn callback_regression");
	expect(text(long)).toBe("fn callback_regression() {}");
});

test("custom themes with matching names retain their own token colors", async () => {
	const request = (foreground: string) =>
		new Promise<HighlightResult>((resolve) => {
			const theme = {
				name: "same-display-name",
				type: "light" as const,
				colors: {
					"editor.foreground": foreground,
					"editor.background": "#ffffff",
				},
				tokenColors: [{ scope: "keyword", settings: { foreground } }],
			};
			const result = staticCodeHighlighter.highlight(
				{
					code: "const colorRegression = 1;",
					language: "ts",
					themes: [theme, theme],
				},
				resolve
			);
			if (result) {
				resolve(result);
			}
		});
	const red = await request("#ff0000");
	const blue = await request("#0000ff");
	expect(tokenSignature(red)).not.toBe(tokenSignature(blue));
	expect(JSON.stringify(red.tokens).toUpperCase()).toContain("#FF0000");
	expect(JSON.stringify(blue.tokens).toUpperCase()).toContain("#0000FF");
});

test("two consumers of a throttled update both receive the trailing result", async () => {
	const run = nextStreamRun();
	await highlight(streamingCodeHighlighter, `let callbackWarm${run} = 1;`);
	jest.useFakeTimers();
	const prefix = `let callbackPair${run} = 1;`;
	streamingCodeHighlighter.highlight({
		code: prefix,
		language: "ts",
		themes: THEMES,
	});
	const code = `${prefix}\nlet callbackPairNext = 2;`;
	const deliveries: HighlightResult[] = [];
	for (let index = 0; index < 2; index++) {
		streamingCodeHighlighter.highlight(
			{ code, language: "ts", themes: THEMES },
			(result) => deliveries.push(result)
		);
	}
	expect(deliveries).toHaveLength(0);
	jest.advanceTimersByTime(STREAM_REDRAW_INTERVAL_MS);
	expect(deliveries).toHaveLength(2);
	expect(deliveries[0]).toBe(deliveries[1]);
	expect(
		deliveries[0]?.tokens
			.map((line) => line.map((token) => token.content).join(""))
			.join("\n")
	).toBe(code);
});

test("completed streaming tokens preserve trailing spaces and final blank lines", async () => {
	const code = "const whitespaceRegression = 1;  \n\n\n";
	const streamed = await highlight(streamingCodeHighlighter, code);
	const reference = await createHighlighter({
		engine: createOnigurumaEngine(import("shiki/wasm")),
		langs: ["ts"],
		themes: THEMES,
	});
	const expected = reference.codeToTokens(code, {
		lang: "ts",
		themes: { dark: THEMES[1], light: THEMES[0] },
	});
	expect(tokenSignature(streamed)).toBe(tokenSignature(expected));
	expect(
		streamed.tokens
			.map((line) => line.map((token) => token.content).join(""))
			.join("\n")
	).toBe(code);
});
