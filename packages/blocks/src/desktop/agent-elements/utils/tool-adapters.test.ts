import { describe, expect, it } from "bun:test";
import {
	mapToolInvocationToStep,
	mapToolNameToVariant,
	mapToolStateToStepState,
} from "./tool-adapters.ts";

describe("mapToolStateToStepState", () => {
	it("maps result to complete and everything else to animating", () => {
		expect(mapToolStateToStepState("result")).toBe("complete");
		expect(mapToolStateToStepState("call")).toBe("animating");
		expect(mapToolStateToStepState("partial-call")).toBe("animating");
	});
});

describe("mapToolNameToVariant", () => {
	it("recognizes thinking/reasoning as thinking", () => {
		expect(mapToolNameToVariant("Thinking")).toBe("thinking");
		expect(mapToolNameToVariant("reasoning")).toBe("thinking");
	});

	it("recognizes web/search/glob/grep tools as search", () => {
		for (const name of [
			"WebSearch",
			"web_search",
			"Grep",
			"Glob",
			"WebFetch",
			"web_fetch",
		]) {
			expect(mapToolNameToVariant(name)).toBe("search");
		}
	});

	it("returns undefined for other tools", () => {
		expect(mapToolNameToVariant("Bash")).toBeUndefined();
		expect(mapToolNameToVariant("Edit")).toBeUndefined();
	});
});

describe("mapToolInvocationToStep - naming + detail", () => {
	it("renames PlanWrite and TodoWrite for display", () => {
		expect(
			mapToolInvocationToStep("1", { toolName: "PlanWrite", state: "call" })
				.toolName
		).toBe("Plan");
		expect(
			mapToolInvocationToStep("2", { toolName: "TodoWrite", state: "call" })
				.toolName
		).toBe("Todo");
	});

	it("extracts the basename for file tools", () => {
		const step = mapToolInvocationToStep("3", {
			toolName: "Read",
			args: { file_path: "/a/b/c/file.ts" },
			state: "call",
		});
		expect(step.toolDetail).toBe("file.ts");
		expect(step.filePath).toBe("/a/b/c/file.ts");
	});

	it("truncates a long Bash command in the detail", () => {
		const cmd = "echo " + "x".repeat(200);
		const step = mapToolInvocationToStep("4", {
			toolName: "Bash",
			args: { command: cmd },
			state: "call",
		});
		expect(step.toolDetail).toHaveLength(80);
		expect(step.bashCommand).toBe(cmd);
	});
});

describe("mapToolInvocationToStep - Bash result flattening", () => {
	it("treats a plain string result as successful stdout", () => {
		const step = mapToolInvocationToStep("b1", {
			toolName: "Bash",
			args: { command: "ls" },
			state: "result",
			result: "file-a\nfile-b",
		});
		expect(step.bashOutput).toBe("file-a\nfile-b");
		expect(step.bashSuccess).toBe(true);
	});

	it("uses exitCode 0 as success and non-zero as failure", () => {
		const ok = mapToolInvocationToStep("b2", {
			toolName: "Bash",
			state: "result",
			result: { output: "done", exitCode: 0 },
		});
		expect(ok.bashSuccess).toBe(true);
		const bad = mapToolInvocationToStep("b3", {
			toolName: "Bash",
			state: "result",
			result: { output: "oops", exitCode: 1 },
		});
		expect(bad.bashSuccess).toBe(false);
	});

	it("falls back to ACP status when there is no exit code", () => {
		const failed = mapToolInvocationToStep("b4", {
			toolName: "Bash",
			state: "result",
			result: { output: "x", status: "failed" },
		});
		expect(failed.bashSuccess).toBe(false);
		const completed = mapToolInvocationToStep("b5", {
			toolName: "Bash",
			state: "result",
			result: { output: "x", status: "completed" },
		});
		expect(completed.bashSuccess).toBe(true);
	});

	it("flattens an ACP array of content blocks into text", () => {
		const step = mapToolInvocationToStep("b6", {
			toolName: "Bash",
			state: "result",
			result: {
				output: [{ type: "text", text: "line1" }, "line2"],
				exitCode: 0,
			},
		});
		expect(step.bashOutput).toBe("line1\nline2");
	});

	it("joins stdout and stderr", () => {
		const step = mapToolInvocationToStep("b7", {
			toolName: "Bash",
			state: "result",
			result: { stdout: "out", stderr: "err", exitCode: 0 },
		});
		expect(step.bashOutput).toBe("out\nerr");
	});
});

describe("mapToolInvocationToStep - diffs", () => {
	it("counts every Write line as an addition", () => {
		const step = mapToolInvocationToStep("w1", {
			toolName: "Write",
			args: { file_path: "/x.ts", content: "a\nb\nc" },
			state: "result",
		});
		expect(step.diffStats).toBe("+3");
		expect(step.diffLines).toHaveLength(3);
		expect(step.diffLines?.[0]).toEqual({ type: "add", content: "a" });
	});

	it("summarizes an Edit structuredPatch into +/- stats and typed lines", () => {
		const step = mapToolInvocationToStep("e1", {
			toolName: "Edit",
			args: { file_path: "/x.ts" },
			state: "result",
			result: {
				structuredPatch: [
					{ lines: ["+added one", "-removed one", " context"] },
				],
			},
		});
		expect(step.diffStats).toBe("+1 -1");
		expect(step.diffLines).toEqual([
			{ type: "add", content: "added one" },
			{ type: "remove", content: "removed one" },
			{ type: "context", content: "context" },
		]);
	});

	it("leaves diffStats undefined when a patch has no changes", () => {
		const step = mapToolInvocationToStep("e2", {
			toolName: "Edit",
			args: { file_path: "/x.ts" },
			state: "result",
			result: { structuredPatch: [{ lines: [" only context"] }] },
		});
		expect(step.diffStats).toBeUndefined();
	});
});

describe("mapToolInvocationToStep - search + thinking", () => {
	it("marks WebSearch as a web search with its query", () => {
		const step = mapToolInvocationToStep("s1", {
			toolName: "WebSearch",
			args: { query: "rust" },
			state: "call",
		});
		expect(step.searchQuery).toBe("rust");
		expect(step.searchSource).toBe("web");
		expect(step.toolVariant).toBe("search");
	});

	it("marks Grep as a code search using its pattern", () => {
		const step = mapToolInvocationToStep("s2", {
			toolName: "Grep",
			args: { pattern: "foo" },
			state: "call",
		});
		expect(step.searchQuery).toBe("foo");
		expect(step.searchSource).toBe("code");
	});

	it("captures the thought content from args or a string result", () => {
		const fromArgs = mapToolInvocationToStep("t1", {
			toolName: "thinking",
			args: { thought: "hmm" },
			state: "call",
		});
		expect(fromArgs.thoughtContent).toBe("hmm");
		const fromResult = mapToolInvocationToStep("t2", {
			toolName: "reasoning",
			state: "result",
			result: "because",
		});
		expect(fromResult.thoughtContent).toBe("because");
	});
});
