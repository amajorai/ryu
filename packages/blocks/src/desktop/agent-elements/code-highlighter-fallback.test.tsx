// Run separately: only the WASM loader is refused; Shiki and its JavaScript
// engine, Streamdown and the production Markdown caller all run unchanged.
import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CodeHighlighterPlugin } from "streamdown";

const actualOniguruma = await import("shiki/engine/oniguruma");
let refusedWasmLoads = 0;
const refuseWasm = () => {
	refusedWasmLoads++;
	throw new Error("fixture host refused WASM");
};
mock.module("shiki/engine/oniguruma", () => ({
	...Object.fromEntries(
		Object.entries(actualOniguruma).map(([key, value]) => [
			key,
			value === actualOniguruma.createOnigurumaEngine ? refuseWasm : value,
		])
	),
	createOnigurumaEngine: refuseWasm,
}));
const actualJavaScript = await import("shiki/engine/javascript");
const genuineJavaScriptFactory = actualJavaScript.createJavaScriptRegexEngine;
let javascriptEngineCreations = 0;
mock.module("shiki/engine/javascript", () => ({
	...actualJavaScript,
	createJavaScriptRegexEngine: (
		...args: Parameters<typeof actualJavaScript.createJavaScriptRegexEngine>
	) => {
		javascriptEngineCreations++;
		return genuineJavaScriptFactory(...args);
	},
}));
const { createHighlighter } = await import("shiki");
const createJavaScriptRegexEngine =
	actualJavaScript.createJavaScriptRegexEngine;
const { staticCodeHighlighter, streamingCodeHighlighter } = await import(
	"./code-highlighter.ts"
);
type Result = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
const themes: ["github-light", "github-dark"] = ["github-light", "github-dark"];
const html = "<script>const answer = 42;</script><button>Hello</button>";
const signature = (result: Result) =>
	JSON.stringify(
		result.tokens.map((line) =>
			line.map((token) => [token.content, token.htmlStyle ?? token.color])
		)
	);
const source = (result: Result) =>
	result.tokens
		.map((line) => line.map((token) => token.content).join(""))
		.join("\n");
function highlight(
	plugin: CodeHighlighterPlugin,
	code: string
): Promise<Result> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("production fallback did not settle")),
			15_000
		);
		const receive = (result: Result) => {
			clearTimeout(timer);
			resolve(result);
		};
		const result = plugin.highlight(
			{ code, language: "html", themes },
			receive
		);
		if (result) {
			receive(result);
		}
	});
}
test("cold real JavaScript fallback renders exact embedded HTML scope tokens", async () => {
	const actual = await highlight(staticCodeHighlighter, html);
	expect(refusedWasmLoads).toBe(1);
	expect(javascriptEngineCreations).toBe(1);
	const oracle = await createHighlighter({
		engine: createJavaScriptRegexEngine({ forgiving: true }),
		langs: ["html"],
		themes,
	});
	try {
		const expected = oracle.codeToTokens(html, {
			lang: "html",
			themes: { light: themes[0], dark: themes[1] },
			tokenizeTimeLimit: 5000,
		});
		expect(source(actual)).toBe(html);
		expect(signature(actual)).toBe(signature(expected));
	} finally {
		oracle.dispose();
	}
}, 20_000);
test("fallback checkpoint and resumed passes match a complete pass; independent prefix requests both settle", async () => {
	const prefix = "<script>\nconst answer = 42;\n";
	const code = `${prefix}const label = \`value \${answer}\`;\n</script><button>Hello</button>`;
	const first = await highlight(streamingCodeHighlighter, prefix);
	expect(source(first)).toBe(prefix);
	let oldDeliveries = 0;
	let oldSource = "";
	const old = streamingCodeHighlighter.highlight(
		{ code: `${prefix}const label`, language: "html", themes },
		(result) => {
			oldDeliveries++;
			oldSource = source(result);
		}
	);
	expect(old).toBeNull();
	const resumed = await highlight(streamingCodeHighlighter, code);
	const finished = await highlight(staticCodeHighlighter, code);
	expect(oldDeliveries).toBe(1);
	expect(oldSource).toBe(`${prefix}const label`);
	expect(source(resumed)).toBe(code);
	expect(signature(resumed)).toBe(signature(finished));
}, 20_000);

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Markdown } = await import("./markdown.tsx");
afterAll(async () => {
	mock.restore();
	await GlobalRegistrator.unregister();
});
test("real streamed Markdown preserves pending source and newest completed fallback output", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const pending = `<section data-proof="cold-newest">\n<script>const count = 3;</script>`;
	const newest = `${pending}\n<button>Newest acknowledged source</button></section>`;
	try {
		await act(async () =>
			root.render(<Markdown content={`\`\`\`html\n${pending}`} isStreaming />)
		);
		const initial = container.querySelector("code");
		expect(renderedSource(initial)).toBe(pending);
		await act(async () =>
			root.render(
				<Markdown content={`\`\`\`html\n${newest}\n\`\`\``} isStreaming />
			)
		);
		// FIFO callback settlement is awaited independently of the raw pending DOM.
		await act(async () => {
			await highlight(streamingCodeHighlighter, pending);
			await highlight(streamingCodeHighlighter, newest);
		});
		await waitColored(container, [newest]);
		expect(renderedSource(container.querySelector("code"))).toBe(newest);
		expect(
			container.querySelector("code span[style]")?.textContent
		).not.toBeNull();
		const clipboardDescriptor = Object.getOwnPropertyDescriptor(
			navigator,
			"clipboard"
		);
		const copied: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (value: string) => {
					copied.push(value);
				},
			},
		});
		try {
			const copy = container.querySelector<HTMLButtonElement>(
				'[data-streamdown="code-block-copy-button"]'
			);
			if (!copy) throw new Error("Actual streamed code copy control is absent");
			// Animation keeps code controls disabled while the reply is arriving.
			expect(copy.disabled).toBe(true);
			await act(async () => copy.click());
			expect(copied).toEqual([]);
			// Finish the actual stream; do not disable the user's animation preference.
			await act(async () =>
				root.render(
					<Markdown
						content={`\`\`\`html\n${newest}\n\`\`\``}
						isStreaming={false}
					/>
				)
			);
			await waitColored(container, [newest]);
			expect(renderedSource(container.querySelector("code"))).toBe(newest);
			const completedCopy = container.querySelector<HTMLButtonElement>(
				'[data-streamdown="code-block-copy-button"]'
			);
			if (!completedCopy)
				throw new Error("Actual completed code copy control is absent");
			expect(completedCopy.disabled).toBe(false);
			await act(async () => completedCopy.click());
			expect(copied).toEqual([`${newest}\n`]);
		} finally {
			if (clipboardDescriptor) {
				Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
			} else {
				Reflect.deleteProperty(navigator, "clipboard");
			}
		}
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
}, 20_000);

function renderedSource(block: Element | null): string {
	return block
		? Array.from(block.children)
				.map((line) =>
					line.textContent === "\n" ? "" : (line.textContent ?? "")
				)
				.join("\n")
				.trimEnd()
		: "";
}

async function waitColored(container: HTMLElement, expected: string[]) {
	const deadline = performance.now() + 15_000;
	while (performance.now() < deadline) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const blocks = Array.from(container.querySelectorAll("code"));
		if (
			blocks.length === expected.length &&
			blocks.every(
				(block, index) =>
					renderedSource(block) === expected[index] &&
					new Set(
						Array.from(block.querySelectorAll<HTMLElement>("span[style]"))
							.map(
								(token) =>
									token.style.getPropertyValue("--sdm-c") ||
									token.style.getPropertyValue("--shiki-light")
							)
							.filter((color) => color && color !== "inherit")
					).size > 1
			)
		) {
			return;
		}
	}
	throw new Error(
		"production Markdown colored output did not settle: " +
			container.textContent?.slice(-500)
	);
}

test("independent same-language streamed Markdown blocks sharing a prefix both receive colored output", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const first = '<article data-proof="independent">First</article>';
	const second = `${first}<button>Second independent block</button>`;
	try {
		await act(async () =>
			root.render(
				<>
					<Markdown content={`\`\`\`html\n${first}\n\`\`\``} isStreaming />
					<Markdown content={`\`\`\`html\n${second}\n\`\`\``} isStreaming />
				</>
			)
		);
		await act(async () => {
			await Promise.all([
				highlight(streamingCodeHighlighter, first),
				highlight(streamingCodeHighlighter, second),
			]);
		});
		await waitColored(container, [first, second]);
		expect(
			Array.from(container.querySelectorAll("code")).map((block) =>
				renderedSource(block)
			)
		).toEqual([first, second]);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
}, 20_000);

// Separate red gate: FIFO alone cannot fence Streamdown's effect callback when
// a later request returns synchronously from the shared result cache.
test("cached newer Markdown cannot be overwritten by an older queued callback", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const older = '<aside data-proof="cache-race">Older queued source</aside>';
	const newer =
		'<aside data-proof="cache-race">Newer cached acknowledged source with distinct length</aside>';
	await highlight(streamingCodeHighlighter, newer);
	try {
		act(() =>
			root.render(
				<Markdown content={`\`\`\`html\n${older}\n\`\`\``} isStreaming />
			)
		);
		act(() =>
			root.render(
				<Markdown content={`\`\`\`html\n${newer}\n\`\`\``} isStreaming />
			)
		);
		await act(async () => {
			await highlight(streamingCodeHighlighter, older);
		});
		await waitColored(container, [newer]);
		expect(renderedSource(container.querySelector("code"))).toBe(newer);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
}, 20_000);

test("same-length Markdown replacement updates colored source", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const older = '<aside data-proof="same-length">Older source</aside>';
	const newer = '<aside data-proof="same-length">Newer source</aside>';
	expect(older.length).toBe(newer.length);
	try {
		await act(async () =>
			root.render(
				<Markdown content={`\`\`\`html\n${older}\n\`\`\``} isStreaming />
			)
		);
		await act(async () => {
			await highlight(streamingCodeHighlighter, older);
		});
		await waitColored(container, [older]);
		await act(async () =>
			root.render(
				<Markdown content={`\`\`\`html\n${newer}\n\`\`\``} isStreaming />
			)
		);
		await act(async () => {
			await highlight(streamingCodeHighlighter, newer);
		});
		await waitColored(container, [newer]);
		expect(renderedSource(container.querySelector("code"))).toBe(newer);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
}, 20_000);
