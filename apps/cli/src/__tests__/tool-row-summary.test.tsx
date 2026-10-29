/* @jsxImportSource @opentui/react */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { TranscriptParts } from "../components/TranscriptParts.tsx";
import type { ChatPart } from "../core/chatTranscript.ts";
import { InputFocusProvider } from "../core/InputFocusContext.tsx";
import { testRender } from "./cli-test-render.ts";

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	const current = setup;
	setup = null;
	if (current) {
		await act(async () => {
			current.renderer.destroy();
		});
	}
});

async function frameFor(parts: ChatPart[], width = 80, noUnicode = false) {
	setup = await testRender(
		<ThemeProvider noUnicode={noUnicode} reducedMotion>
			<InputFocusProvider>
				<TranscriptParts parts={parts} />
			</InputFocusProvider>
		</ThemeProvider>,
		{ width, height: 16 }
	);
	await setup.renderOnce();
	return setup.captureCharFrame();
}

const SETTLED: ChatPart[] = [
	{
		type: "tool",
		toolCallId: "read-1",
		name: "Read",
		status: "success",
		args: { file_path: "src/index.ts" },
		result: "contents",
		startedAt: 1000,
		endedAt: 1300,
	},
	{
		type: "tool",
		toolCallId: "bash-1",
		name: "Bash",
		status: "success",
		args: { command: "bun test" },
		result: "ok",
		startedAt: 2000,
		endedAt: 4100,
	},
	{
		type: "tool",
		toolCallId: "edit-1",
		name: "Edit",
		status: "success",
		args: { file_path: "src/a.ts", old_string: "a", new_string: "b\nc" },
		startedAt: 5000,
		endedAt: 5042,
	},
];

test("collapsed tool rows show summary, diff stat and settled duration", async () => {
	const frame = await frameFor(SETTLED);
	expect(frame).toMatch(/✓ Read src\/index\.ts · 0\.3s ▶/);
	expect(frame).toMatch(/✓ Bash \$ bun test · 2\.1s ▶/);
	expect(frame).toMatch(/✓ Edit src\/a\.ts \+2 -1 · 42ms ▶/);
});

test("legacy tool parts without timestamps render no duration", async () => {
	const frame = await frameFor([
		{
			type: "tool",
			name: "Read",
			status: "success",
			args: { file_path: "src/index.ts" },
		},
	]);
	expect(frame).toMatch(/✓ Read src\/index\.ts ▶/);
	expect(frame).not.toContain("NaN");
	expect(frame).not.toContain("·");
});

test("a part that re-entered running shows live time, not a stale duration", async () => {
	const frame = await frameFor([
		{
			type: "tool",
			toolCallId: "bash-2",
			name: "Bash",
			status: "running",
			args: { command: "bun test" },
			startedAt: 0,
			endedAt: 2100,
		},
	]);
	expect(frame).toMatch(/Running \$ bun test · \d+(?:\.\d)?m?s ▶/);
	expect(frame).not.toContain("2.1s");
});

test("in-flight rows use gerund labels", async () => {
	const frame = await frameFor([
		{
			type: "tool",
			toolCallId: "grep-1",
			name: "Grep",
			status: "pending",
			args: { pattern: "foo", path: "src" },
		},
	]);
	expect(frame).toContain('○ Searching "foo" in src ▶');
});

test("narrow rows truncate the summary before the duration and caret", async () => {
	const frame = await frameFor(
		[
			{
				type: "tool",
				toolCallId: "read-long",
				name: "Read",
				status: "success",
				args: { file_path: `${"nested/".repeat(8)}target.ts` },
				startedAt: 0,
				endedAt: 1200,
			},
		],
		36
	);
	const row = frame.split("\n").find((line) => line.includes("Read")) ?? "";
	expect(row.trimEnd().endsWith("· 1.2s ▶")).toBe(true);
	expect(row).toContain("...");
	expect(row).not.toContain("nested/".repeat(8));
});

test("ASCII mode keeps status icons and caret honest", async () => {
	const frame = await frameFor(SETTLED.slice(0, 1), 80, true);
	expect(frame).toContain("[x] Read src/index.ts · 0.3s >");
	expect(frame).not.toMatch(/[✓▶]/);
});
