/* @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { MarkdownRenderable, type Renderable, rgbToHex } from "@opentui/core";
import { act, useState } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { ChatMarkdown } from "../components/ChatMarkdown.tsx";
import { resolveThemePreference } from "../core/themePreferences.ts";
import { testRender } from "./cli-test-render.ts";
import { contrastRatio, MIN_TEXT_CONTRAST } from "./color-contrast.ts";

async function renderMarkdown(content: string, width = 80) {
	return await testRender(
		<ThemeProvider reducedMotion>
			<ChatMarkdown content={content} />
		</ThemeProvider>,
		{ width, height: 12 }
	);
}

type Setup = Awaited<ReturnType<typeof testRender>>;

// MarkdownRenderable paints finished prose once the tree-sitter worker has
// highlighted it, so frames are polled in real time instead of render passes.
async function settledFrame(
	setup: Setup,
	ready: (frame: string) => boolean
): Promise<string> {
	const deadline = Date.now() + 5000;
	let frame = setup.captureCharFrame();
	while (!ready(frame) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	return frame;
}

function findMarkdown(node: Renderable): MarkdownRenderable | undefined {
	if (node instanceof MarkdownRenderable) {
		return node;
	}
	for (const child of node.getChildren()) {
		const found = findMarkdown(child as Renderable);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function nonEmptyRows(frame: string): string[] {
	return frame.split("\n").filter((row) => row.trim().length > 0);
}

test("inline bold, italic, code and link segments share one concealed row", async () => {
	const setup = await renderMarkdown(
		"Here is **bold**, *italic*, `code`, and a [link](x)."
	);
	try {
		const frame = await settledFrame(setup, (current) =>
			current.includes("Here is")
		);
		const rows = nonEmptyRows(frame);
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row).toContain("Here is bold, italic, code, and a link");
		expect(row).not.toContain("**");
		expect(row).not.toContain("`");
	} finally {
		setup.renderer.destroy();
	}
});

test("bold and italic prose stays legible on the light theme", async () => {
	const light = resolveThemePreference({ mode: "light", preset: "ryu" });
	const setup = await testRender(
		<ThemeProvider reducedMotion theme={light}>
			<box backgroundColor={light.colors.background} flexGrow={1}>
				<ChatMarkdown content="Plain **heavy** and *slanted* words." />
			</box>
		</ThemeProvider>,
		{ width: 60, height: 4 }
	);
	try {
		await settledFrame(setup, (current) => current.includes("slanted"));
		const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
		for (const word of ["heavy", "slanted"]) {
			const span = spans.find((candidate) => candidate.text.includes(word));
			expect(span).toBeDefined();
			if (span) {
				expect(
					contrastRatio(rgbToHex(span.fg), rgbToHex(span.bg))
				).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
			}
		}
	} finally {
		setup.renderer.destroy();
	}
});

test("a markdown table renders as a bordered grid", async () => {
	const setup = await renderMarkdown("| h1 | h2 |\n| --- | --- |\n| a | b |");
	try {
		const frame = await settledFrame(setup, (current) =>
			current.includes("│ a")
		);
		const rows = nonEmptyRows(frame).map((row) => row.trimEnd());
		// A 2x2 grid: top border, header, separator, body row, bottom border,
		// with padded cells sized to their content rather than the full width.
		expect(rows).toEqual([
			"┌────┬────┐",
			"│ h1 │ h2 │",
			"├────┼────┤",
			"│ a  │ b  │",
			"└────┴────┘",
		]);
	} finally {
		setup.renderer.destroy();
	}
});

test("fenced code is syntax highlighted with theme tokens", async () => {
	const setup = await renderMarkdown('```ts\nconst greeting = "hi";\n```');
	try {
		await settledFrame(setup, (current) => current.includes("greeting"));
		// Highlighting lands after the text first paints; wait for the keyword
		// to pick up its own color before inspecting spans.
		const deadline = Date.now() + 5000;
		const keywordColor = () =>
			setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.startsWith("const"));
		const stringColor = () =>
			setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes('"hi"'));
		while (
			(keywordColor()?.fg.equals(stringColor()?.fg) ?? true) &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			await setup.renderOnce();
		}
		const keyword = keywordColor();
		const string = stringColor();
		expect(keyword).toBeDefined();
		expect(string).toBeDefined();
		expect(keyword?.fg.equals(string?.fg)).toBe(false);
	} finally {
		setup.renderer.destroy();
	}
});

test("parts sharing a theme share one syntax style", async () => {
	const setup = await testRender(
		<ThemeProvider reducedMotion>
			<box flexDirection="column">
				<ChatMarkdown content="first" />
				<ChatMarkdown content="second" />
			</box>
		</ThemeProvider>,
		{ width: 40, height: 6 }
	);
	try {
		await settledFrame(setup, (current) => current.includes("second"));
		const found: MarkdownRenderable[] = [];
		const collect = (node: Renderable) => {
			if (node instanceof MarkdownRenderable) {
				found.push(node);
			}
			for (const child of node.getChildren()) {
				collect(child as Renderable);
			}
		};
		collect(setup.renderer.root);
		expect(found).toHaveLength(2);
		expect(found[0]?.syntaxStyle).toBe(found[1]?.syntaxStyle);
	} finally {
		setup.renderer.destroy();
	}
});

test("finishing a stream finalizes the trailing block", async () => {
	let update!: (next: { content: string; streaming: boolean }) => void;
	function View() {
		const [state, setState] = useState({
			content: "Done paragraph.\n\nStill **bo",
			streaming: true,
		});
		update = setState;
		return (
			<ThemeProvider reducedMotion>
				<ChatMarkdown content={state.content} streaming={state.streaming} />
			</ThemeProvider>
		);
	}
	const setup = await testRender(<View />, { width: 80, height: 12 });
	try {
		await act(async () => {
			update({
				content: "Done paragraph.\n\nStill **bold**",
				streaming: true,
			});
		});
		await act(async () => {
			update({
				content: "Done paragraph.\n\nStill **bold** text",
				streaming: false,
			});
		});
		const frame = await settledFrame(
			setup,
			(current) =>
				current.includes("Done paragraph.") && current.includes("text")
		);
		expect(frame).toContain("Done paragraph.");
		expect(frame).toContain("Still bold text");
		expect(frame).not.toContain("**");
	} finally {
		setup.renderer.destroy();
	}
});

test("streaming appends reuse the finished block and stay bounded", async () => {
	let append!: (text: string) => void;
	function View() {
		const [tail, setTail] = useState("Streaming");
		append = (text) => setTail((current) => current + text);
		return (
			<ThemeProvider reducedMotion>
				<ChatMarkdown
					content={`Finished paragraph sentinel.\n\n${tail}`}
					streaming
				/>
			</ThemeProvider>
		);
	}
	const setup = await testRender(<View />, { width: 80, height: 12 });
	try {
		const markdown = findMarkdown(setup.renderer.root);
		expect(markdown).toBeDefined();
		const finishedBlock = markdown?.getChildren()[0];
		expect(finishedBlock).toBeDefined();
		const started = performance.now();
		for (let chunk = 0; chunk < 30; chunk++) {
			await act(async () => {
				append(` w${chunk}`);
			});
		}
		const frame = await settledFrame(
			setup,
			(current) => current.includes("sentinel") && current.includes("w29")
		);
		// Generous ceiling: incremental parsing should not re-render the whole
		// document per token, and 30 appends finish far below this bound.
		expect(performance.now() - started).toBeLessThan(5000);
		// The finished paragraph keeps its renderable: appends only rebuild the
		// trailing unstable block.
		expect(markdown?.getChildren()[0]).toBe(finishedBlock);
		expect(frame).toContain("Finished paragraph sentinel.");
		expect(frame).toContain("w29");
		expect(
			frame.split("\n").filter((row) => row.includes("sentinel"))
		).toHaveLength(1);
	} finally {
		setup.renderer.destroy();
	}
});
