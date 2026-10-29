/* @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act, type ReactNode, useEffect } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { TranscriptParts } from "../components/TranscriptParts.tsx";
import type { ChatPart } from "../core/chatTranscript.ts";
import {
	InputFocusProvider,
	useSetInputFocused,
} from "../core/InputFocusContext.tsx";
import {
	formatReasoningDuration,
	reasoningTitle,
} from "../core/transcriptPresentation.ts";
import { testRender } from "./cli-test-render.ts";

const REASONING_BODY = "hidden-reasoning-body";

function FocusedComposer({ children }: { children: ReactNode }) {
	const setInputFocused = useSetInputFocused();
	useEffect(() => {
		setInputFocused(true);
	}, [setInputFocused]);
	return <>{children}</>;
}

async function renderParts(parts: ChatPart[], streaming: boolean, width = 80) {
	return await testRender(
		<ThemeProvider reducedMotion>
			<InputFocusProvider>
				<FocusedComposer>
					<TranscriptParts parts={parts} streaming={streaming} />
				</FocusedComposer>
			</InputFocusProvider>
		</ThemeProvider>,
		{ width, height: 12 }
	);
}

test("reasoningTitle prefers a leading bold heading, then the first line", () => {
	expect(reasoningTitle("**Planning edits**\nThen more")).toBe(
		"Planning edits"
	);
	expect(reasoningTitle("\n\n  First line here\nsecond")).toBe(
		"First line here"
	);
	expect(reasoningTitle("plain **not leading** text")).toBe(
		"plain **not leading** text"
	);
	expect(reasoningTitle("")).toBe("");
	expect(reasoningTitle("abcdefghij", 6)).toBe("abcde…");
	expect(reasoningTitle("\u001b[31mred\u001b[0m")).toBe("red");
});

test("formatReasoningDuration omits missing timestamps and scales to minutes", () => {
	expect(formatReasoningDuration(1000, 5200)).toBe("4.2s");
	expect(formatReasoningDuration(undefined, 5200)).toBeUndefined();
	expect(formatReasoningDuration(1000, undefined)).toBeUndefined();
	expect(formatReasoningDuration(5000, 1000)).toBeUndefined();
	expect(formatReasoningDuration(0, 65_000)).toBe("1m 5s");
});

test("finished reasoning is one collapsed row that composer keys never toggle", async () => {
	const setup = await renderParts(
		[
			{
				type: "reasoning",
				text: `**Checking files**\n${REASONING_BODY}`,
				startedAt: 1000,
				endedAt: 5200,
			},
			{ type: "text", text: "Answer" },
		],
		false
	);
	try {
		// The answer is finished markdown, which paints once highlighting
		// settles; poll real time for it before inspecting rows.
		let collapsed = setup.captureCharFrame();
		const deadline = Date.now() + 5000;
		while (!collapsed.includes("Answer") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			await setup.renderOnce();
			collapsed = setup.captureCharFrame();
		}
		const rows = collapsed.split("\n").filter((line) => line.trim());
		const thoughtRows = rows.filter((line) => line.includes("Thought"));
		expect(thoughtRows).toHaveLength(1);
		expect(thoughtRows[0]).toContain("+ Thought: Checking files · 4.2s");
		// The reasoning row is the first row; the answer follows after the gap.
		expect(rows[0]).toBe(thoughtRows[0]);
		expect(rows[1]?.trim()).toBe("Answer");
		expect(collapsed).not.toContain(REASONING_BODY);

		setup.mockInput.pressEnter();
		setup.mockInput.pressKey(" ");
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain(REASONING_BODY);

		await setup.mockMouse.click(4, 0);
		await setup.renderOnce();
		const expanded = setup.captureCharFrame();
		expect(expanded).toContain("- Thought: Checking files · 4.2s");
		expect(expanded).toContain(REASONING_BODY);

		await setup.mockMouse.click(4, 0);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain(REASONING_BODY);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test("streaming reasoning shows the bold title and legacy parts omit duration", async () => {
	const streamingSetup = await renderParts(
		[{ type: "reasoning", text: "**Planning edits**\nbody", startedAt: 1 }],
		true
	);
	try {
		await streamingSetup.renderOnce();
		const frame = streamingSetup.captureCharFrame();
		expect(frame).toContain("Thinking: Planning edits");
		expect(frame).not.toContain("Thought");
	} finally {
		await act(async () => {
			streamingSetup.renderer.destroy();
		});
	}

	const legacySetup = await renderParts(
		[{ type: "reasoning", text: "Old reasoning" }],
		false
	);
	try {
		await legacySetup.renderOnce();
		const row = legacySetup
			.captureCharFrame()
			.split("\n")
			.find((line) => line.includes("Thought"));
		expect(row?.trim()).toBe("+ Thought: Old reasoning");
	} finally {
		await act(async () => {
			legacySetup.renderer.destroy();
		});
	}
});

test("a narrow pane truncates only the title and keeps the marker and duration", async () => {
	const setup = await renderParts(
		[
			{
				type: "reasoning",
				text: "**Inspecting the repository layout before answering**",
				startedAt: 0,
				endedAt: 12_300,
			},
		],
		false,
		24
	);
	try {
		await setup.renderOnce();
		const row = setup
			.captureCharFrame()
			.split("\n")
			.find((line) => line.includes("Thought"));
		expect(row?.trimStart().startsWith("+ Thought: ")).toBe(true);
		expect(row?.trimEnd().endsWith("· 12.3s")).toBe(true);
		expect(row?.trimEnd().length).toBeLessThanOrEqual(24);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
