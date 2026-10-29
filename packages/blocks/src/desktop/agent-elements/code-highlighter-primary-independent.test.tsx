// Separate process: genuine primary engine, production plugin and mounted caller.
import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const actual = await import("shiki/engine/oniguruma");
const factory = actual.createOnigurumaEngine;
let primaryCreations = 0;
const tracked: typeof factory = (...args) => {
	primaryCreations++;
	return factory(...args);
};
mock.module("shiki/engine/oniguruma", () => ({
	...Object.fromEntries(
		Object.entries(actual).map(([key, value]) => [
			key,
			value === factory ? tracked : value,
		])
	),
	createOnigurumaEngine: tracked,
}));
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Markdown } = await import("./markdown.tsx");
const { streamingCodeHighlighter } = await import("./code-highlighter.ts");
afterAll(async () => {
	mock.restore();
	await GlobalRegistrator.unregister();
});
test("genuine primary engine preserves two independent growing blocks sharing a prefix", async () => {
	const prefix = "<script>\nconst answer = 42;\n";
	await new Promise<void>((resolve) => {
		const result = streamingCodeHighlighter.highlight(
			{
				code: prefix,
				language: "html",
				themes: ["github-light", "github-dark"],
			},
			() => resolve()
		);
		if (result) {
			resolve();
		}
	});
	expect(primaryCreations).toBe(1);
	const first = `${prefix}const first = answer;\n</script>`;
	const second = `${prefix}const second = answer + 1;\n</script>`;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
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
			await new Promise((resolve) => setTimeout(resolve, 250));
		});
		const blocks = Array.from(container.querySelectorAll("code"));
		expect(blocks).toHaveLength(2);
		expect(
			blocks.map((block) =>
				Array.from(block.children)
					.map((line) =>
						line.textContent === "\n" ? "" : (line.textContent ?? "")
					)
					.join("\n")
					.trimEnd()
			)
		).toEqual([first, second]);
		for (const block of blocks) {
			expect(
				new Set(
					Array.from(block.querySelectorAll<HTMLElement>("span[style]"))
						.map(
							(token) =>
								token.style.getPropertyValue("--sdm-c") ||
								token.style.getPropertyValue("--shiki-light")
						)
						.filter((color) => color && color !== "inherit")
				).size
			).toBeGreaterThan(1);
		}
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
}, 20_000);
