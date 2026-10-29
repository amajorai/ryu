import { expect, test } from "bun:test";
import {
	boundTerminalText,
	boundToolArguments,
	completedTodoCount,
	formatToolDuration,
	formatToolOutput,
	sanitizeTerminalText,
	TRANSCRIPT_LIMITS,
	todoStatusPresentation,
	toolActivityLabel,
	toolArgumentsForPresentation,
	toolDiffStat,
	toolDurationMs,
	toolPendingLabel,
	toolSummary,
} from "../core/transcriptPresentation.ts";

test("sanitizes terminal control sequences and keeps bounded text within both limits", () => {
	const presentation = boundTerminalText(
		"\u001b[31mfirst\u001b[0m\r\nsecond\nthird",
		{ label: "message", maxChars: 64, maxLines: 2 }
	);

	expect(presentation.truncated).toBe(true);
	expect(presentation.text).not.toContain("\u001b");
	expect(presentation.text).toContain("[message truncated:");
	expect(presentation.text.length).toBeLessThanOrEqual(64);
	expect(presentation.text.split("\n")).toHaveLength(2);
});

test("formats and bounds structured tool output without leaking control characters", () => {
	const output = formatToolOutput({
		status: "ok",
		stdout: `${"line\n".repeat(120)}\u001b[2J`,
	});

	expect(output).toBeDefined();
	expect(output?.length).toBeLessThanOrEqual(TRANSCRIPT_LIMITS.toolOutputChars);
	expect(output).not.toContain("\u001b");
	expect(output).toContain("[tool output truncated:");
});

test("bounds tool args and promotes result-supplied diffs for the Diff primitive", () => {
	const args = boundToolArguments({
		file_path: "src/example.ts",
		patch: "a\tline\n".repeat(200),
	});
	const withResultDiff = toolArgumentsForPresentation(
		"Edit",
		{ file_path: "src/example.ts" },
		{
			output: "--- src/example.ts\n+++ src/example.ts\n@@ -1 +1 @@\n-old\n+new",
		}
	);

	expect(args?.patch).toBeString();
	expect(String(args?.patch).length).toBeLessThanOrEqual(
		TRANSCRIPT_LIMITS.toolArgumentChars + 200
	);
	expect(withResultDiff?.patch).toContain("@@ -1 +1 @@");
});

test("uses readable todo status semantics with an ASCII fallback", () => {
	expect(todoStatusPresentation("completed")).toMatchObject({
		icon: "✓",
		kind: "completed",
		tone: "success",
	});
	expect(todoStatusPresentation("in_progress", false)).toMatchObject({
		icon: "[>]",
		kind: "in_progress",
		tone: "primary",
	});
	expect(todoStatusPresentation("blocked", false)).toMatchObject({
		icon: "[!]",
		kind: "error",
		tone: "error",
	});
	expect(
		completedTodoCount([
			{ status: "completed" },
			{ status: "in_progress" },
			{ status: "done" },
		])
	).toBe(2);
	expect(sanitizeTerminalText("a\tb\u0007")).toBe("a  b");
});

test("summarizes each tool kind on one row", () => {
	expect(
		toolSummary("Read", { file_path: "src/a.ts", offset: 10, limit: 50 })
	).toBe("src/a.ts:10-60");
	expect(toolSummary("Read", { file_path: "src/index.ts" })).toBe(
		"src/index.ts"
	);
	expect(toolSummary("Bash", { command: "bun test" })).toBe("$ bun test");
	expect(toolSummary("Edit", { file_path: "src/b.ts", old_string: "a" })).toBe(
		"src/b.ts"
	);
	expect(toolSummary("Write", { path: "notes.md", content: "x" })).toBe(
		"notes.md"
	);
	expect(toolSummary("Grep", { pattern: "foo", path: "src" })).toBe(
		'"foo" in src'
	);
	expect(toolSummary("Glob", { pattern: "**/*.ts" })).toBe('"**/*.ts"');
	expect(
		toolSummary("WebFetch", { url: "https://docs.example.com/a?b=1" })
	).toBe("docs.example.com");
	expect(toolSummary("mcp__notes__lookup", { id: 7, topic: "ryu" })).toBe(
		"ryu"
	);
	expect(toolSummary("Bash")).toBeUndefined();
	expect(toolSummary("Bash", { timeout: 5 })).toBeUndefined();
});

test("tool summaries accept ACP rawInput, snake_case and MCP names", () => {
	expect(
		toolSummary("read_file", { rawInput: { path: "README.md" }, title: "x" })
	).toBe("README.md");
	expect(toolSummary("mcp__fs__read_file", { path: "a.ts" })).toBe("a.ts");
	expect(toolSummary("ReadFile", { filePath: "b.ts" })).toBe("b.ts");
	expect(toolSummary("shell", { command: ["git", "status"] })).toBe(
		"$ git status"
	);
	expect(
		toolSummary("apply_patch", {
			patch: "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-a\n+b",
		})
	).toBe("src/c.ts");
});

test("tool summaries stay single-line, sanitized and bounded", () => {
	expect(
		toolSummary("Bash", { command: "cd app &&\n  bun test\u001b[2J" })
	).toBe("$ cd app && …");
	expect(toolSummary("web_fetch", { url: "not a url" })).toBe("not a url");
	const longPath = `${"deep/".repeat(40)}file.ts`;
	const summary = toolSummary("Read", { file_path: longPath }) ?? "";
	expect([...summary].length).toBe(TRANSCRIPT_LIMITS.toolSummaryChars);
	expect(summary.startsWith("…")).toBe(true);
	expect(summary.endsWith("file.ts")).toBe(true);
	const longCommand = toolSummary("Bash", { command: "x".repeat(300) }) ?? "";
	expect([...longCommand].length).toBe(TRANSCRIPT_LIMITS.toolSummaryChars);
	expect(longCommand.endsWith("…")).toBe(true);
	expect(toolSummary("Grep", { pattern: "a\tb\u0007" })).toBe('"a b"');
	const rangedRead =
		toolSummary("Read", { file_path: longPath, offset: 100, limit: 50 }) ?? "";
	expect([...rangedRead].length).toBe(TRANSCRIPT_LIMITS.toolSummaryChars);
	expect(rangedRead.endsWith("file.ts:100-150")).toBe(true);
});

test("counts diff lines for edits excluding file headers", () => {
	expect(
		toolDiffStat(
			"Edit",
			{
				patch:
					"--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n ctx",
			},
			undefined
		)
	).toEqual({ added: 2, removed: 1 });
	expect(
		toolDiffStat(
			"Edit",
			{ file_path: "a.ts", old_string: "a\nb", new_string: "c" },
			undefined
		)
	).toEqual({ added: 1, removed: 2 });
	expect(
		toolDiffStat(
			"edit",
			{ rawInput: { path: "a.ts" } },
			{
				output: "--- a\n+++ b\n-x\n+y\n+z",
			}
		)
	).toEqual({ added: 2, removed: 1 });
	expect(toolDiffStat("Read", { patch: "-a\n+b" }, undefined)).toBeUndefined();
	expect(toolDiffStat("Edit", { file_path: "a.ts" }, "done")).toBeUndefined();
});

test("labels in-flight tools with gerunds", () => {
	expect(toolPendingLabel("Read")).toBe("Reading");
	expect(toolPendingLabel("bash")).toBe("Running");
	expect(toolPendingLabel("Edit")).toBe("Editing");
	expect(toolPendingLabel("Write")).toBe("Writing");
	expect(toolPendingLabel("Grep")).toBe("Searching");
	expect(toolPendingLabel("Glob")).toBe("Searching");
	expect(toolPendingLabel("WebFetch")).toBe("Fetching");
	expect(toolPendingLabel("custom_tool")).toBe("custom_tool");
});

test("labels the status row with the running tool's activity", () => {
	expect(toolActivityLabel("Bash")).toBe("Running command…");
	expect(toolActivityLabel("Read")).toBe("Reading files…");
	expect(toolActivityLabel("Edit")).toBe("Editing files…");
	expect(toolActivityLabel("Grep")).toBe("Searching…");
	expect(toolActivityLabel("WebFetch")).toBe("Fetching…");
	expect(toolActivityLabel("custom_tool")).toBe("Running custom_tool…");
	expect(toolActivityLabel("\u001b[31mevil\u001b[0m")).toBe("Running evil…");
	expect(toolActivityLabel("  ")).toBe("Running tool…");
	const longName = "mcp__github__pull_request_review_write_with_extra_detail";
	const clamped = toolActivityLabel(longName);
	expect(clamped).toBe("Running mcp__github__pull_req…");
	expect([...clamped].length).toBeLessThanOrEqual(30);
});

test("formats tool durations at their boundaries", () => {
	expect(formatToolDuration(0)).toBe("0ms");
	expect(formatToolDuration(42)).toBe("42ms");
	expect(formatToolDuration(99)).toBe("99ms");
	expect(formatToolDuration(100)).toBe("0.1s");
	expect(formatToolDuration(300)).toBe("0.3s");
	expect(formatToolDuration(999)).toBe("1.0s");
	expect(formatToolDuration(1000)).toBe("1.0s");
	expect(formatToolDuration(2149)).toBe("2.1s");
	expect(formatToolDuration(59_900)).toBe("59.9s");
	expect(formatToolDuration(59_960)).toBe("1m 0s");
	expect(formatToolDuration(64_000)).toBe("1m 4s");
	expect(formatToolDuration(Number.NaN)).toBe("0ms");
});

test("tool durations are absent for legacy or inconsistent parts", () => {
	expect(toolDurationMs({ startedAt: 100, endedAt: 400 })).toBe(300);
	expect(toolDurationMs({})).toBeUndefined();
	expect(toolDurationMs({ startedAt: 100 })).toBeUndefined();
	expect(toolDurationMs({ startedAt: 500, endedAt: 100 })).toBeUndefined();
});
